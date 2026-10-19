/**
 * oc-relay —— SillyTavern Server Plugin（ESM，零 npm 依赖，仅用 node 内置模块）
 *
 * 作用：把下游 OpenAI 兼容请求反向代理到 OpenCode Go 上游
 * (https://opencode.ai/zen/go)，并补齐上游要求的身份 / 路由头：
 *   - x-opencode-session: 同一 prefix + 同一聊天恒定（gate-safe 派生，见 deriveSessionId）
 *   - x-opencode-request: 每请求新生成（msg_ + canonical 26 位）
 *   - x-opencode-client:  cli
 *   - User-Agent:         opencode/1.18.x
 *
 * 挂载点（由 SillyTavern plugin-loader 完成）：/api/plugins/oc-relay
 * 下游 baseURL 示例：https://<ST-host>/api/plugins/oc-relay/<prefix>/v1
 * prefix 规则：路径第一段，非 [0-9A-Za-z] 字符丢弃后截断到 6 位；
 *             为空时用 "default"；请求头 x-opencode-prefix 优先于路径。
 */

import crypto from 'node:crypto';
import { once } from 'node:events';

/** 上游 origin（不含 /v1）；测试或自建时可用环境变量覆盖。 */
const UPSTREAM_ORIGIN = process.env.OC_RELAY_UPSTREAM || 'https://opencode.ai/zen/go';

/** 上游端点。 */
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';

const DEFAULT_PREFIX = 'default';
const MAX_PREFIX_LENGTH = 6;

/** 与官方 packages/schema/src/identifier.ts 一致的 62 进制字母表。 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** opencode CLI 身份头（上游会解析 UA 版本，需 >= 1.17）。 */
const OPENCODE_USER_AGENT = 'opencode/1.18.31';
const OPENCODE_CLIENT = 'cli';

/** 上游不可用时 /v1/models 的最小静态兜底列表。 */
const FALLBACK_MODELS = {
  object: 'list',
  data: [{ id: 'deepseek-v4-flash', object: 'model', owned_by: 'opencode' }],
};

// ---------------------------------------------------------------------------
// prefix 解析
// ---------------------------------------------------------------------------

/**
 * 从请求头取值（兼容重复头）。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name 小写头名
 * @returns {string}
 */
function readHeader(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

/**
 * 规范化 prefix：丢弃非法字符后截断到 6 位。
 * @param {unknown} value
 * @returns {string}
 */
function sanitizePrefix(value) {
  return String(value ?? '')
    .replace(/[^0-9A-Za-z]/g, '')
    .slice(0, MAX_PREFIX_LENGTH);
}

/**
 * 解析本次请求的 prefix：header 优先、path 回退、都为空则 default。
 * @param {import('node:http').IncomingMessage & { params?: Record<string, string> }} req
 * @returns {string}
 */
function resolvePrefix(req) {
  const fromHeader = sanitizePrefix(readHeader(req, 'x-opencode-prefix'));
  if (fromHeader) return fromHeader;
  return sanitizePrefix(req.params?.prefix) || DEFAULT_PREFIX;
}

// ---------------------------------------------------------------------------
// chatKey 与 session / request ID 派生
// ---------------------------------------------------------------------------

/**
 * 将 message.content 归一化为文本（兼容 string 与 content parts 数组）。
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/**
 * system + 首条 user 的 sha256 短指纹，作为没有 x-st-chat-key 时的 chatKey。
 * @param {any} body 已解析的请求体
 * @returns {string} 16 位 hex
 */
function fingerprintChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages
    .filter(message => message?.role === 'system')
    .map(message => contentToText(message.content))
    .join('\n');
  const firstUser = messages.find(message => message?.role === 'user');
  const raw = `sys\u0000${system}\u0000user\u0000${firstUser ? contentToText(firstUser.content) : ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * 官方 identifier.ts 的字节 -> base62 映射（byte % 62）。
 * @param {Buffer} bytes
 * @param {number} length
 * @returns {string}
 */
function base62(bytes, length) {
  return Array.from(bytes.subarray(0, length), byte => BASE62[byte % 62]).join('');
}

/**
 * 派生 gate-safe 的 ses_ ID（对同一 prefix + chatKey 恒定，不同 prefix 隔离）：
 *   H      = sha256("ses\0" + prefix + "\0" + chatKey)
 *   hex12  = H 前 6 字节 hex；低 12 bit 被固定为 counter(0..63)，
 *            以满足官方 identifier.ts 中 low-12-bit counter 的约束
 *   tail14 = prefix 前 4 位 + base62(H[6..]) 补齐/截断到恰好 14 位
 *   结果满足 ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$
 * @param {string} prefix sanitize 后的 prefix
 * @param {string} chatKey
 * @returns {string}
 */
function deriveSessionId(prefix, chatKey) {
  const digest = crypto.createHash('sha256').update(`ses\u0000${prefix}\u0000${chatKey}`).digest();
  const raw = BigInt(`0x${digest.subarray(0, 6).toString('hex')}`);
  const counterBits = BigInt(digest[6] & 0x3f); // 0..63
  const hex12 = ((raw & 0xfffffffff000n) | counterBits).toString(16).padStart(12, '0');
  const prefixTag = prefix.slice(0, 4);
  return `ses_${hex12}${prefixTag}${base62(digest.subarray(6), 14 - prefixTag.length)}`;
}

let lastTimestamp = 0;
let idCounter = 0;

/**
 * 每请求新生成 msg_ + canonical（同官方 identifier.ts 生成器：正序时间戳 + counter + 62 进制随机）。
 * counter 与官方一致落在低 12 bit，且不超过 63。
 * @returns {string}
 */
function createRequestId() {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter = idCounter >= 63 ? 1 : idCounter + 1;
  const value = (BigInt(timestamp) * 0x1000n + BigInt(idCounter)) & 0xffffffffffffn;
  return `msg_${value.toString(16).padStart(12, '0')}${base62(crypto.randomBytes(14), 14)}`;
}

// ---------------------------------------------------------------------------
// 请求体读取与上游转发
// ---------------------------------------------------------------------------

/**
 * 读取下游请求体。
 * ST 全局 body-parser 已消费流时，回退为对 req.body 重新 JSON 序列化；
 * 这里刻意不使用 express.json() 去消费上游 body。
 * @param {import('node:http').IncomingMessage & { body?: any }} req
 * @returns {Promise<Buffer>}
 */
async function readRequestBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (req.body !== undefined && req.body !== null) {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  if (req.readableEnded) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * 构造上游请求头：显式白名单，天然剔除 Host / Content-Length / Origin / Accept-Encoding 等
 * 下游头；Authorization 透传。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} sessionId
 * @returns {Record<string, string>}
 */
function buildUpstreamHeaders(req, sessionId) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': OPENCODE_USER_AGENT,
    'x-opencode-client': OPENCODE_CLIENT,
    'x-opencode-session': sessionId,
    'x-opencode-request': createRequestId(),
    // 显式禁用压缩：保证 SSE / JSON 字节级透传，避免 fetch 自动解压造成头身不一致。
    'accept-encoding': 'identity',
  };
  const authorization = readHeader(req, 'authorization');
  if (authorization) headers.authorization = authorization;
  return headers;
}

/**
 * 把上游响应（含 SSE）按字节转发给下游；客户端断开时中止上游请求。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ method: string, path: string, body?: Buffer, sessionId: string }} options
 */
async function relayUpstream(req, res, { method, path, body, sessionId }) {
  const upstreamAbort = new AbortController();
  // 注意：Node >= 16 中 req 'close' 在请求体接收完成时即触发，不能用作断开信号；
  // res 'close' + writableEnded 才是可靠的客户端断开检测（req 'aborted' 作为补充）。
  const abortOnDisconnect = () => {
    if (!res.writableEnded) upstreamAbort.abort();
  };
  req.on('aborted', abortOnDisconnect);
  res.on('close', abortOnDisconnect);

  const upstream = await fetch(`${UPSTREAM_ORIGIN}${path}`, {
    method,
    headers: buildUpstreamHeaders(req, sessionId),
    body,
    redirect: 'manual',
    signal: upstreamAbort.signal,
  });

  const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8';
  const isEventStream = contentType.includes('text/event-stream');

  res.status(upstream.status);
  res.setHeader('Content-Type', contentType);
  if (isEventStream) {
    // no-transform 让 ST 全局 compression 中间件跳过 SSE，避免流式输出被缓冲。
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  } else {
    res.setHeader('Cache-Control', upstream.headers.get('cache-control') ?? 'no-store');
  }
  res.flushHeaders();

  if (!upstream.body) {
    res.end();
    return;
  }

  for await (const chunk of upstream.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!res.write(buffer)) await once(res, 'drain');
  }
  res.end();
}

/**
 * 上游失败时返回 502；若已开始输出则直接结束。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 */
function sendUpstreamError(res, error) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(502).json({ error: { message: `oc-relay upstream error: ${message}`, type: 'oc_relay_error' } });
}

// ---------------------------------------------------------------------------
// 路由处理器
// ---------------------------------------------------------------------------

/**
 * POST :prefix/v1/chat/completions（或 /v1/chat/completions）。
 * @param {any} req
 * @param {any} res
 */
async function handleChatCompletions(req, res) {
  try {
    const prefix = resolvePrefix(req);
    const body = await readRequestBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      // 非 JSON body 照常转发
    }
    const chatKey = readHeader(req, 'x-st-chat-key') || fingerprintChat(parsed);
    const sessionId = deriveSessionId(prefix, chatKey);
    console.info(`[oc-relay] POST chat/completions prefix=${prefix} session=${sessionId}`);
    await relayUpstream(req, res, { method: 'POST', path: CHAT_COMPLETIONS_PATH, body, sessionId });
  } catch (error) {
    if (res.headersSent) {
      // 客户端断开会走到这里（AbortError），不是插件故障。
      console.warn(`[oc-relay] chat/completions stream ended early: ${error instanceof Error ? error.message : error}`);
    } else {
      console.error('[oc-relay] chat/completions failed:', error);
    }
    sendUpstreamError(res, error);
  }
}

/**
 * GET :prefix/v1/models（或 /v1/models）：透传上游；失败时返回最小静态列表。
 * @param {any} req
 * @param {any} res
 */
async function handleModels(req, res) {
  const prefix = resolvePrefix(req);
  const chatKey = readHeader(req, 'x-st-chat-key') || fingerprintChat(null);
  const sessionId = deriveSessionId(prefix, chatKey);
  try {
    const upstream = await fetch(`${UPSTREAM_ORIGIN}${MODELS_PATH}`, {
      method: 'GET',
      headers: buildUpstreamHeaders(req, sessionId),
      redirect: 'manual',
    });
    if (!upstream.ok) throw new Error(`upstream responded ${upstream.status}`);
    res.status(200).json(await upstream.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[oc-relay] models fallback (${message})`);
    res.status(200).json(FALLBACK_MODELS);
  }
}

// ---------------------------------------------------------------------------
// SillyTavern Server Plugin 生命周期
// ---------------------------------------------------------------------------

/**
 * SillyTavern 在启动时调用；router 会被挂载到 /api/plugins/oc-relay。
 * @param {import('express').Router} router
 */
export async function init(router) {
  router.post(['/v1/chat/completions', '/:prefix/v1/chat/completions'], handleChatCompletions);
  router.get(['/v1/models', '/:prefix/v1/models'], handleModels);
  console.info('[oc-relay] mounted at /api/plugins/oc-relay');
}

export async function exit() {
  console.info('[oc-relay] unloaded');
}

export const info = {
  id: 'oc-relay',
  name: 'oc-relay',
  description:
    'OpenAI-compatible reverse proxy to opencode.ai/zen/go that derives x-opencode-session / x-opencode-request headers (zero npm dependencies).',
};
