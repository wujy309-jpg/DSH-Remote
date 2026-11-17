#!/usr/bin/env node
/**
 * DSH Remote relay —— 公网服务器侧。
 *
 * 职责：
 *   1. 在 127.0.0.1:8848 上对外提供 HTTPS 站点（由 nginx 终止 TLS 并反代过来）。
 *   2. 用一次性配对码换取长期 HttpOnly 会话 cookie，之后浏览器无需再输密码。
 *   3. 把浏览器的 HTTP 请求 / WebSocket 连接多路复用进与 Mac 之间唯一那条 WSS。
 *
 * 设计取舍：
 *   - 只允许一条 agent 连接（新的顶掉旧的），避免多台 Mac 抢同一入口。
 *   - 所有流共享同一条 WSS：大响应时整体降速（TCP 语义），不做逐流窗口。
 *   - 单流缓冲上限 8MB，超限直接掐断，防止把内存打爆。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { MANIFEST, iconPng } from './icon.js'
import { contentDisposition, previewMime } from './mime.js'
import {
  KIND_HTTP,
  KIND_WS_BIN,
  KIND_WS_TEXT,
  MAX_STREAM_BUFFER,
  HTTP_STREAM_TIMEOUT_MS,
  dataFrame,
  parseDataFrame,
  stripHopByHop,
} from './protocol.js'

// ---------------------------------------------------------------- 配置

const CONFIG_PATH = process.env.DSH_RELAY_CONFIG ?? '/etc/dsh-relay/config.json'
const CONFIG = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}

const PORT = Number(process.env.PORT ?? CONFIG.port ?? 8848)
const BIND = process.env.BIND ?? CONFIG.bind ?? '127.0.0.1'
const AGENT_TOKEN = String(process.env.AGENT_TOKEN ?? CONFIG.agentToken ?? '')
const SESSION_SECRET = String(process.env.SESSION_SECRET ?? CONFIG.sessionSecret ?? '')
const COOKIE_NAME = CONFIG.cookieName ?? 'dsh_relay'
const SESSION_TTL_MS = Number(CONFIG.sessionTtlMs ?? 180 * 24 * 3600 * 1000)
const PAIR_CODE_TTL_MS = Number(CONFIG.pairCodeTtlMs ?? 15 * 60 * 1000)
const AGENT_PROTOCOL = 'dsh-relay-v1'

/**
 * 对外地址（用于给系统浏览器签一次性下载链接）。
 * 优先取配置项 `publicBaseUrl`；没配就从反向代理传进来的 Host 头推。
 * 仓库里不写死任何一个具体域名。
 */
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ?? CONFIG.publicBaseUrl ?? '',
).replace(/\/+$/, '')

if (!AGENT_TOKEN || AGENT_TOKEN.length < 24) {
  console.error('[dsh-relay] AGENT_TOKEN 缺失或过短，拒绝启动')
  process.exit(2)
}
if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
  console.error('[dsh-relay] SESSION_SECRET 缺失或过短，拒绝启动')
  process.exit(2)
}

const log = (...args) => console.log(new Date().toISOString(), ...args)

/**
 * 这一次请求对外应该声明成哪个站点根地址（`https://host`）。
 *
 * 顺序：配置项 `publicBaseUrl` → `X-Forwarded-Host` → `Host`。
 * nginx 反代默认会带 Host，所以正常情况下总能推出来；实在推不出来就返回空串，
 * 调用方退化成相对路径，并在日志里提醒一次。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL
  const first = (value) => String(value ?? '').split(',')[0].trim()
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host)
  if (!host) return ''
  const proto = first(req.headers['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http')
  return `${proto}://${host}`
}

let warnedMissingBaseUrl = false

/** 推不出对外地址时只吵一次，别把日志刷满。 */
function warnMissingBaseUrlOnce() {
  if (warnedMissingBaseUrl) return
  warnedMissingBaseUrl = true
  log(
    '[warn] 推不出对外站点地址（没有 publicBaseUrl，也没有 Host 头）：' +
      '一次性下载链接会退化成相对路径。请在 config.json 里配 publicBaseUrl。',
  )
}


// ---------------------------------------------------------------- 会话 cookie

/** base64url 去掉填充，省得 cookie 里出现 `=`。 */
const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * 签发会话 cookie 值。
 * @param {number} issuedAt
 * @returns {string}
 */
function signSession(issuedAt) {
  const payload = `v1.${issuedAt}`
  const mac = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

/**
 * 校验会话 cookie 值（含过期）。
 * @param {string|undefined} value
 * @returns {boolean}
 */
function verifySession(value) {
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return false
  const issuedAt = Number(parts[1])
  if (!Number.isSafeInteger(issuedAt)) return false
  if (Date.now() - issuedAt > SESSION_TTL_MS) return false
  const expected = createHmac('sha256', SESSION_SECRET).update(`v1.${issuedAt}`).digest('base64url')
  const a = Buffer.from(parts[2])
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 从 Cookie 头里取一个值。
 * @param {string|undefined} header
 * @param {string} name
 * @returns {string|undefined}
 */
function readCookie(header, name) {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() !== name) continue
    return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

// ---------------------------------------------------------------- 配对码

let pairCode = ''
let pairCodeIssuedAt = 0

/** 人类可读、好念的 8 位码（去掉易混字符）。 */
function makePairCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

function rotatePairCode() {
  pairCode = makePairCode()
  pairCodeIssuedAt = Date.now()
  log(`[pair] 新配对码 ${pairCode}（${Math.round(PAIR_CODE_TTL_MS / 60000)} 分钟内有效）`)
  broadcastPairCode()
  return pairCode
}

function pairCodeValid(code) {
  if (!pairCode) return false
  if (Date.now() - pairCodeIssuedAt > PAIR_CODE_TTL_MS) return false
  const expected = Buffer.from(pairCode)
  const given = Buffer.from(String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''))
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** 配对尝试限速：同一 IP 10 分钟内最多 6 次。 */
const PAIR_WINDOW_MS = 10 * 60 * 1000
const PAIR_MAX_ATTEMPTS = Number(CONFIG.pairMaxAttempts ?? process.env.PAIR_MAX_ATTEMPTS ?? 10)
/** @type {Map<string, { count: number, start: number }>} */
const pairAttempts = new Map()

/** 全局闸门：分布式撞码时，单个 IP 的限速形同虚设，这里加一道总量兜底。 */
const GLOBAL_WINDOW_MS = 5 * 60 * 1000
const GLOBAL_MAX_FAILS = 1000
const GLOBAL_LOCK_MS = 5 * 60 * 1000
const globalFails = { count: 0, start: 0, lockUntil: 0 }

function globalGuard() {
  const now = Date.now()
  if (globalFails.lockUntil > now) return false
  if (now - globalFails.start > GLOBAL_WINDOW_MS) {
    globalFails.count = 0
    globalFails.start = now
  }
  return true
}

function globalRecordFailure() {
  const now = Date.now()
  if (now - globalFails.start > GLOBAL_WINDOW_MS) {
    globalFails.count = 0
    globalFails.start = now
  }
  globalFails.count += 1
  if (globalFails.count >= GLOBAL_MAX_FAILS) {
    globalFails.lockUntil = now + GLOBAL_LOCK_MS
    log(`[pair] 全局失败 ${globalFails.count} 次，暂停配对 ${Math.round(GLOBAL_LOCK_MS / 60000)} 分钟`)
  }
}

function pairAttemptAllowed(ip) {
  const now = Date.now()
  const rec = pairAttempts.get(ip)
  if (!rec || now - rec.start > PAIR_WINDOW_MS) {
    pairAttempts.set(ip, { count: 1, start: now })
    return true
  }
  rec.count += 1
  return rec.count <= PAIR_MAX_ATTEMPTS
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, rec] of pairAttempts) if (now - rec.start > PAIR_WINDOW_MS) pairAttempts.delete(ip)
  if (!pairCode || now - pairCodeIssuedAt > PAIR_CODE_TTL_MS) {
    // 过期就地换一张新的：如果只是清空，在没人配对的情况下就再也不会生成了。
    log('[pair] 配对码过期，自动换新')
    rotatePairCode()
  }
}, 60_000).unref()

// ---------------------------------------------------------------- agent 连接

/** @type {import('ws').WebSocket | null} */
let agentWs = null
let agentConnectedAt = 0
/** 上游（Mac 上的 DSH）是否没在跑——由 agent 告知，用来给手机一个说得清的页面。 */
let upstreamDown = { down: false, reason: '' }

/** 反向暂停计数：多条流共享一条 socket，任意一条背压就整体降速。 */
let agentPauseDepth = 0

function pauseAgentSocket() {
  agentPauseDepth += 1
  if (agentPauseDepth === 1) agentWs?._socket?.pause?.()
}

function resumeAgentSocket() {
  if (agentPauseDepth === 0) return
  agentPauseDepth -= 1
  if (agentPauseDepth === 0) agentWs?._socket?.resume?.()
}

/**
 * 给 agent 发控制帧。
 * @param {Record<string, unknown>} msg
 * @returns {boolean}
 */
function sendControl(msg) {
  if (agentWs?.readyState !== 1) return false
  agentWs.send(JSON.stringify(msg))
  return true
}

/**
 * 给 agent 发数据帧。
 * @param {number} id
 * @param {number} kind
 * @param {Buffer} payload
 */
function sendData(id, kind, payload) {
  if (agentWs?.readyState !== 1) return
  agentWs.send(dataFrame(id, kind, payload), { binary: true })
}

function broadcastPairCode() {
  if (!pairCode) return
  sendControl({ t: 'pair', code: pairCode, expiresAt: pairCodeIssuedAt + PAIR_CODE_TTL_MS })
}

// ---------------------------------------------------------------- 流

/**
 * @typedef {object} Stream
 * @property {number} id
 * @property {'http'|'ws'} kind
 * @property {import('node:http').ServerResponse} [res]
 * @property {import('node:http').IncomingMessage} [req]
 * @property {import('ws').WebSocket} [ws]
 * @property {number} buffered
 * @property {NodeJS.Timeout} [timer]
 * @property {boolean} closed
 */

/** @type {Map<number, Stream>} */
const streams = new Map()
let nextStreamId = 1

function allocStreamId() {
  for (let i = 0; i < 1_000_000; i += 1) {
    const id = nextStreamId
    nextStreamId = nextStreamId >= 0x7fffffff ? 1 : nextStreamId + 1
    if (!streams.has(id)) return id
  }
  throw new Error('stream id 耗尽')
}

/**
 * 关闭一条流并释放资源。
 * @param {number} id
 * @param {string} [reason]
 */
function closeStream(id, reason) {
  const stream = streams.get(id)
  if (!stream || stream.closed) return
  stream.closed = true
  streams.delete(id)
  if (stream.timer) clearTimeout(stream.timer)
  try {
    if (stream.kind === 'http') {
      if (stream.res && !stream.res.writableEnded) stream.res.destroy()
    } else {
      stream.ws?.close(1001, reason ?? 'relay closed')
    }
  } catch {
    /* 已经关了就算了 */
  }
}

// ---------------------------------------------------------------- 静态页面

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function styleBlock() {
  return `<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;padding:24px}
.card{background:#171a21;border:1px solid #262b36;border-radius:16px;padding:28px 24px;max-width:360px;width:100%;
box-shadow:0 18px 50px rgba(0,0,0,.45)}
.logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#4d6bfe,#8b5cf6);margin-bottom:16px}
h1{font-size:17px;margin:0 0 6px;font-weight:600}
p{font-size:13px;line-height:1.7;color:#9aa4b2;margin:0 0 18px}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #2b3240;background:#0f1319;color:#e5e7eb;
font-size:16px;letter-spacing:.18em;text-transform:uppercase;text-align:center;outline:none}
input:focus{border-color:#4d6bfe}
button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#4d6bfe;color:#fff;font-size:14px;
font-weight:600;cursor:pointer}
button:active{transform:translateY(1px)}
.err{color:#f87171;font-size:12px;margin-top:10px;min-height:16px}
.hint{font-size:12px;color:#6b7280;margin-top:14px;line-height:1.7}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
</style>`
}

function loginPage({ error = '', next = '/' } = {}) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>DSH Remote · 配对</title>${styleBlock()}</head><body>
<form class="card" method="post" action="/__pair">
  <div class="logo"></div>
  <h1>连接你的 DSH</h1>
  <p>输入 Mac 上显示的 8 位配对码。配对一次，这台手机长期免输。</p>
  <input name="code" inputmode="text" autocomplete="one-time-code" maxlength="12" placeholder="ABCD2345" autofocus required>
  <button type="submit">连接</button>
  <div class="err">${escapeHtml(error)}</div>
  <div class="hint">配对码在 Mac 的终端里，或运行 <code>cat ~/.dsh/remote/pair.txt</code>。</div>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
</form></body></html>`
}

function offlinePage(reason = 'agent') {
  const isUpstream = reason === 'upstream'
  const title = isUpstream ? '电脑上的 DSH 没在运行' : 'Mac 现在没连上'
  const body = isUpstream
    ? '服务器和 Mac 都通着，但 DSH 本体没起来。在电脑上打开 DeepSeek Harness（或 <code>dsh web</code>），本页会自动恢复。'
    : '服务器在线，但你的 Mac 还没接入。检查电脑是否开机、联网，以及 <code>dsh-remote</code> 是否在运行。'
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<meta http-equiv="refresh" content="5">
<title>DSH Remote · ${title}</title>${styleBlock()}</head><body>
<div class="card">
  <div class="logo"></div>
  <h1>${title}</h1>
  <p>${body}<br>本页每 5 秒自动重试。</p>
  <div class="hint"><span class="dot" style="background:#f59e0b"></span>relay 在线 · ${isUpstream ? 'DSH 离线' : 'agent 离线'}</div>
</div></body></html>`
}

/** 为「没有 cookie 的系统浏览器」签一个 5 分钟有效的下载链接。 */
function signFileLink(path, exp) {
  return createHmac('sha256', SESSION_SECRET).update(`fs|${path}|${exp}`).digest('base64url')
}

function verifyFileLink(path, exp, sig) {
  if (!Number.isFinite(exp) || Date.now() > exp) return false
  const expected = signFileLink(path, exp)
  const a = Buffer.from(String(sig ?? ''))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------- 请求处理

/**
 * 判断这次请求是否已配对。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isAuthed(req) {
  return verifySession(readCookie(req.headers.cookie, COOKIE_NAME))
}

/**
 * 取真实的来源 IP，用来限速。
 *
 * 只信 nginx 自己写进来的东西：
 *   - X-Real-IP 是 nginx 用 `$remote_addr` 覆盖写死的，客户端伪造不了；
 *   - X-Forwarded-For 用 `$proxy_add_x_forwarded_for` 时会「客户端值 + 真实 IP」，
 *     所以取**最后一跳**才是可信的那一段。
 * 之前取第一段，等于把限速开关交给了攻击者（实测换一个伪造头就绕过）。
 */
function clientIp(req) {
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return req.socket.remoteAddress ?? 'unknown'
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(html)
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 处理配对：GET 带 code（二维码链接）或 POST 表单。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handlePair(req, res, url) {
  const ip = clientIp(req)
  let code = url.searchParams.get('code') ?? ''
  let next = url.searchParams.get('next') ?? '/'

  if (req.method === 'POST') {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 8192) break
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const form = new URLSearchParams(body)
    code = form.get('code') ?? ''
    next = form.get('next') ?? '/'
  }

  if (!/^\/[^/\\]/.test(next) || next.startsWith('//')) next = '/'

  if (!globalGuard()) {
    return sendHtml(res, 429, loginPage({ error: '配对服务暂时限流，请几分钟后再试。', next }))
  }

  if (!pairAttemptAllowed(ip)) {
    log(`[pair] ${ip} 尝试过于频繁`)
    return sendHtml(res, 429, loginPage({ error: '尝试次数过多，请 10 分钟后再试。', next }))
  }

  if (!pairCodeValid(code)) {
    globalRecordFailure()
    log(`[pair] ${ip} 配对码错误`)
    const wantsHtml = req.method === 'POST' || /text\/html/.test(String(req.headers.accept ?? ''))
    if (!wantsHtml) return sendJson(res, 401, { ok: false, error: 'bad_code' })
    return sendHtml(res, 401, loginPage({ error: '配对码不对，或已过期。', next }))
  }

  pairAttempts.delete(ip)
  const cookie = signSession(Date.now())
  log(`[pair] ${ip} 配对成功`)
  rotatePairCode()
  const maxAge = Math.floor(SESSION_TTL_MS / 1000)
  sendHtml(res, 200, handoffPage(next), {
    'set-cookie': `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  })
}

/** 配对成功后用一个 200 过渡页种 cookie（iOS Safari 在纯 IP/重定向上丢 cookie 的老毛病）。 */
function handoffPage(next) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="refresh" content="0; url=${escapeHtml(next)}">
<title>DSH Remote · 正在进入</title>${styleBlock()}</head><body>
<div class="card"><div class="logo"></div><h1>配对成功</h1><p>正在进入你的 DSH…</p></div>
<script>location.replace(${JSON.stringify(next)})</script></body></html>`
}

/**
 * 把浏览器请求转发进隧道。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function tunnelRequest(req, res) {
  const id = allocStreamId()
  const bodyless = req.method === 'GET' || req.method === 'HEAD'
  /** @type {Stream} */
  const stream = {
    id,
    kind: 'http',
    res,
    req,
    buffered: 0,
    closed: false,
    timer: setTimeout(() => {
      log(`[stream ${id}] 超时`)
      sendControl({ t: 'abort', id, reason: 'timeout' })
      closeStream(id, 'timeout')
    }, HTTP_STREAM_TIMEOUT_MS),
  }
  streams.set(id, stream)

  const headers = stripHopByHop(req.headers)
  // 上游看到的是本机地址：这样 dsh-pocket 和 DSH 自己的 Host/Origin 栅栏都按 loopback 放行，
  // 鉴权只由本 relay 承担（单点）。
  headers.host = '127.0.0.1'
  const url = req.url ?? '/'

  sendControl({ t: 'req', id, method: req.method ?? 'GET', url, headers })

  res.on('close', () => {
    if (!stream.closed) {
      sendControl({ t: 'abort', id, reason: 'client-closed' })
      closeStream(id, 'client-closed')
    }
  })

  res.on('drain', () => resumeAgentSocket())

  if (bodyless) {
    sendControl({ t: 'reqend', id })
    return
  }

  req.on('data', (chunk) => {
    if (stream.closed) return
    stream.buffered += chunk.length
    if (stream.buffered > MAX_STREAM_BUFFER) {
      sendControl({ t: 'abort', id, reason: 'request-too-large' })
      closeStream(id, 'request-too-large')
      return
    }
    stream.buffered -= chunk.length // 请求体不再累计（已经交给 socket 缓冲）
    sendData(id, KIND_HTTP, chunk)
  })
  req.on('end', () => sendControl({ t: 'reqend', id }))
  req.on('error', () => closeStream(id, 'request-error'))
}

/**
 * 处理来自 agent 的控制帧。
 * @param {Record<string, any>} msg
 */
function onAgentControl(msg) {
  const stream = typeof msg.id === 'number' ? streams.get(msg.id) : undefined
  switch (msg.t) {
    case 'res': {
      if (!stream || stream.kind !== 'http' || !stream.res) return
      if (stream.res.headersSent) return
      const headers = stripHopByHop(msg.headers ?? {})
      // 我们自己控制压缩与连接语义
      delete headers['content-length']
      stream.res.writeHead(Number(msg.status) || 502, msg.statusText || undefined, headers)
      return
    }
    case 'resend': {
      if (!stream || stream.kind !== 'http' || !stream.res) return
      if (!stream.res.writableEnded) stream.res.end()
      closeStream(stream.id, 'done')
      return
    }
    case 'wsopened': {
      if (!stream || stream.kind !== 'ws') return
      stream.ws?.emit('relay-opened', msg)
      return
    }
    case 'error': {
      log(`[stream ${msg.id}] agent 报错: ${msg.message}`)
      if (stream?.kind === 'http' && stream.res && !stream.res.headersSent) {
        sendHtml(stream.res, 502, `<h1>502</h1><p>${escapeHtml(String(msg.message ?? 'upstream error'))}</p>`)
      }
      if (stream) closeStream(stream.id, 'agent-error')
      return
    }
    case 'abort': {
      if (stream) closeStream(stream.id, 'abort')
      return
    }
    case 'fshead': {
      const current = streams.get(msg.id)
      if (!current || current.kind !== 'fs' || !current.res) return
      if (current.res.headersSent) return
      const name = String(msg.name ?? 'file')
      const mime = previewMime(name)
      const headers = {
        'content-type': mime,
        'content-disposition': contentDisposition(name),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      }
      const size = Number(msg.size)
      if (Number.isFinite(size) && size >= 0) headers['content-length'] = size
      current.res.writeHead(200, headers)
      return
    }
    case 'fsend': {
      const current = streams.get(msg.id)
      if (current?.res && !current.res.writableEnded) current.res.end()
      if (current) closeStream(current.id, 'done')
      return
    }
    case 'fsfail': {
      const current = streams.get(msg.id)
      if (current?.res && !current.res.headersSent) {
        current.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        current.res.end(`取不到这个文件：${msg.message ?? 'unknown'}`)
      }
      if (current) closeStream(current.id, 'fsfail')
      return
    }
    case 'upstream': {
      upstreamDown = { down: Boolean(msg.down), reason: String(msg.reason ?? '') }
      if (upstreamDown.down) log('[agent] 上游 DSH 未运行')
      return
    }
    case 'ping':
      // agent 靠这条 pong 判断「链路还活着」。不回的话，它的静默检测会周期性
      // 把连接判死并重连——每次重连都会掐断所有在途请求，表现就是手机上
      // 点开对话白屏。
      sendControl({ t: 'pong', at: Date.now() })
      return
    case 'pong':
      return
    default:
      return
  }
}

/**
 * 处理来自 agent 的数据帧。
 * @param {number} id
 * @param {number} kind
 * @param {Buffer} payload
 */
function onAgentData(id, kind, payload) {
  const stream = streams.get(id)
  if (!stream) return

  if (stream.kind === 'http' || stream.kind === 'fs') {
    if (!stream.res || stream.res.writableEnded) return
    const ok = stream.res.write(payload)
    if (!ok) pauseAgentSocket()
    return
  }

  const ws = stream.ws
  if (!ws || ws.readyState !== 1) return
  ws.send(payload, { binary: kind === KIND_WS_BIN })
}

/**
 * 浏览器的 WebSocket 升级：转成一条隧道流。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
function tunnelUpgrade(req, socket, head) {
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (agentWs?.readyState !== 1) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }

  const id = allocStreamId()
  const headers = stripHopByHop(req.headers)
  headers.host = '127.0.0.1'
  const protocol = req.headers['sec-websocket-protocol']

  wss.handleUpgrade(req, socket, head, (ws) => {
    /** @type {Stream} */
    const stream = { id, kind: 'ws', ws, buffered: 0, closed: false }
    streams.set(id, stream)

    ws.on('message', (data, isBinary) => {
      if (stream.closed) return
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      sendData(id, isBinary ? KIND_WS_BIN : KIND_WS_TEXT, buf)
    })
    ws.on('close', (code, reason) => {
      if (stream.closed) return
      sendControl({ t: 'wsclose', id, code, reason: reason?.toString?.() ?? '' })
      closeStream(id, 'client-ws-closed')
    })
    ws.on('error', () => closeStream(id, 'client-ws-error'))

    sendControl({ t: 'wsopen', id, url: req.url ?? '/', headers, protocol: protocol ?? '' })
  })
}

// ---------------------------------------------------------------- HTTP 服务

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const path = url.pathname

  if (path === '/__health') {
    return sendJson(res, 200, {
      ok: true,
      agent: agentWs?.readyState === 1,
      agentSince: agentConnectedAt || null,
      pairPending: Boolean(pairCode),
      upstreamDown: upstreamDown.down,
      streams: streams.size,
      uptimeSec: Math.round(process.uptime()),
    })
  }

  // PWA 资源必须公开：Chrome 抓取 manifest / 图标时不带 cookie，走鉴权会 401，
  // 「添加到主屏幕」就拿不到图标和名字。
  if (path === '/manifest.webmanifest') {
    const body = Buffer.from(JSON.stringify(MANIFEST))
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'content-length': body.length,
    })
    res.end(body)
    return
  }

  if (path.startsWith('/__pwa/') || path === '/apple-touch-icon.png') {
    const iconMatch = /^\/__pwa\/icon-(\d+)(-maskable)?\.png$/.exec(path)
    const size = iconMatch ? Number(iconMatch[1]) : 180
    const maskable = Boolean(iconMatch?.[2])
    if (![180, 192, 512].includes(size)) {
      res.writeHead(404)
      res.end()
      return
    }
    const png = iconPng(size, maskable)
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
      'content-length': png.length,
    })
    res.end(png)
    return
  }

  if (path === '/__fs/link') {
    if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    const target = url.searchParams.get('p') ?? ''
    if (!target) return sendJson(res, 400, { ok: false, error: 'missing p' })
    const exp = Date.now() + 5 * 60 * 1000
    const signed = signFileLink(target, exp)
    const query = `__fs?p=${encodeURIComponent(target)}&exp=${exp}&sig=${encodeURIComponent(signed)}`
    let base = publicBaseUrl(req)
    if (!base) {
      warnMissingBaseUrlOnce()
      base = ''
    }
    const link = base ? `${base}/${query}` : `/${query}`
    // 直接回纯文本 URL：App 侧要拿去 ACTION_VIEW，不需要再解一层 JSON
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(link)
    return
  }

  if (path === '/__fs') {
    const target = url.searchParams.get('p') ?? ''
    const exp = Number(url.searchParams.get('exp') ?? '')
    const sig = url.searchParams.get('sig') ?? ''
    // 两条准入路径：带会话 cookie，或带一次性签名（给系统浏览器用）
    const allowed = isAuthed(req) || verifyFileLink(target, exp, sig)
    if (!allowed) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return
    }
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('missing p')
      return
    }
    if (agentWs?.readyState !== 1) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Mac 未连接')
      return
    }
    const id = allocStreamId()
    /** @type {Stream} */
    const stream = { id, kind: 'fs', res, buffered: 0, closed: false, fileSize: 0, fileName: '' }
    streams.set(id, stream)
    res.on('close', () => {
      if (!stream.closed) closeStream(id, 'client-closed')
    })
    res.on('drain', () => resumeAgentSocket())
    sendControl({ t: 'fs', id, path: target })
    return
  }

  if (path === '/__pair') {
    try {
      await handlePair(req, res, url)
    } catch (error) {
      log('[pair] 处理失败', error)
      sendHtml(res, 500, loginPage({ error: '服务器开小差了，稍后再试。' }))
    }
    return
  }

  if (path === '/__logout') {
    res.writeHead(302, {
      location: '/',
      'set-cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    })
    res.end()
    return
  }

  if (path === '/favicon.ico' && !isAuthed(req)) {
    res.writeHead(204)
    res.end()
    return
  }

  if (!isAuthed(req)) {
    return sendHtml(res, 401, loginPage({ next: path + url.search }))
  }

  if (agentWs?.readyState !== 1) {
    return sendHtml(res, 503, offlinePage('agent'))
  }

  if (upstreamDown.down) {
    return sendHtml(res, 503, offlinePage('upstream'))
  }

  if (path === '/__pair-code') {
    return sendJson(res, 200, { code: pairCode, expiresAt: pairCodeIssuedAt + PAIR_CODE_TTL_MS })
  }

  tunnelRequest(req, res)
})

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 64 * 1024 * 1024,
  handleProtocols: (protocols) => (protocols.has(AGENT_PROTOCOL) ? AGENT_PROTOCOL : false),
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')

  if (url.pathname !== '/__agent') {
    tunnelUpgrade(req, socket, head)
    return
  }

  // agent 侧鉴权：subprotocol 里带 `auth.<token>`，避免 token 出现在 URL / 访问日志里。
  const offered = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim())
  const authEntry = offered.find((p) => p.startsWith('auth.'))
  const token = authEntry ? authEntry.slice(5) : ''
  const tokenOk =
    token.length === AGENT_TOKEN.length &&
    timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(AGENT_TOKEN).digest())

  if (!offered.includes(AGENT_PROTOCOL) || !tokenOk) {
    log('[agent] 鉴权失败，拒绝连接')
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (agentWs && agentWs.readyState === 1) {
      log('[agent] 新连接顶替旧连接')
      try {
        agentWs.close(4000, 'replaced')
      } catch {
        /* ignore */
      }
    }
    agentWs = ws
    agentConnectedAt = Date.now()
    log('[agent] 已连接')

    for (const id of [...streams.keys()]) closeStream(id, 'agent-reconnected')

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        try {
          const frame = parseDataFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
          onAgentData(frame.id, frame.kind, frame.payload)
        } catch (error) {
          log('[agent] 数据帧解析失败', error)
        }
        return
      }
      try {
        onAgentControl(JSON.parse(String(data)))
      } catch (error) {
        log('[agent] 控制帧解析失败', error)
      }
    })

    ws.on('close', () => {
      if (agentWs === ws) {
        agentWs = null
        agentConnectedAt = 0
        log('[agent] 断开')
        for (const id of [...streams.keys()]) closeStream(id, 'agent-gone')
      }
    })
    ws.on('error', (error) => log('[agent] socket 错误', error.message))

    // 心跳：25s 一次，两轮没回应就踢掉，触发 agent 重连。
    let alive = true
    const hb = setInterval(() => {
      if (ws.readyState !== 1) return
      if (!alive) {
        log('[agent] 心跳超时')
        ws.terminate()
        return
      }
      alive = false
      ws.ping()
    }, 25_000)
    ws.on('pong', () => {
      alive = true
    })
    ws.on('close', () => clearInterval(hb))

    sendControl({ t: 'hello', protocol: '1', serverTime: Date.now() })
    broadcastPairCode()
  })
})

// ---------------------------------------------------------------- 启动

server.listen(PORT, BIND, () => {
  log(`[dsh-relay] 监听 http://${BIND}:${PORT}`)
  rotatePairCode()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`[dsh-relay] 收到 ${signal}，退出`)
    for (const id of [...streams.keys()]) closeStream(id, 'shutdown')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}

process.on('uncaughtException', (error) => log('[dsh-relay] uncaught', error))
process.on('unhandledRejection', (error) => log('[dsh-relay] unhandled', error))
