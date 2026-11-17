#!/usr/bin/env node
/**
 * DSH Remote agent —— 跑在你 Mac 上。
 *
 * 它主动向外连 relay（出站长连接，所以 NAT / 换网 / 4G 都不影响），
 * 然后把 relay 转发过来的 HTTP 与 WebSocket 请求打到本机 dsh-pocket（127.0.0.1:3081），
 * 由 pocket 再转给真正的 DSH（127.0.0.1:<随机端口>）。
 *
 * 为什么多绕一层 pocket：它已经解决了移动端布局、Host/Origin 栅栏、launch-token 握手、
 * 压缩这些脏活。这里只负责搬运字节。
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  realpathSync,
  statSync,
  createReadStream,
} from 'node:fs'
import { request as httpRequest, Agent as HttpAgent } from 'node:http'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { WebSocket } from 'ws'
import { createDshAuthFilter } from './dsh-auth.mjs'

// ---------------------------------------------------------------- 配置

const HOME = homedir()
const CONFIG_PATH = process.env.DSH_REMOTE_CONFIG ?? join(HOME, '.dsh', 'remote', 'config.json')
const PAIR_PATH = join(HOME, '.dsh', 'remote', 'pair.txt')
const LOCK_PATH = join(HOME, '.dsh', 'remote', 'agent.pid')
const LOG_PREFIX = '[dsh-remote]'
const DEBUG = process.env.DSH_REMOTE_DEBUG === '1'

if (!existsSync(CONFIG_PATH)) {
  console.error(`${LOG_PREFIX} 缺少配置：${CONFIG_PATH}`)
  process.exit(2)
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const relayUrl = String(config.relay ?? '').replace(/\/+$/, '')
const token = String(config.token ?? '')
const upstreamHost = config.upstreamHost ?? '127.0.0.1'
const upstreamPort = Number(config.upstreamPort ?? 3081)
const pocketPinFile = config.pocketPinFile ?? join(HOME, '.dsh', 'dsh-pocket', 'token-lan')

if (!relayUrl || !token) {
  console.error(`${LOG_PREFIX} config.json 缺 relay 或 token`)
  process.exit(2)
}

const log = (...args) => console.log(new Date().toISOString(), LOG_PREFIX, ...args)

// ---------------------------------------------------------------- 单实例

mkdirSync(dirname(LOCK_PATH), { recursive: true })
if (existsSync(LOCK_PATH)) {
  const other = Number(readFileSync(LOCK_PATH, 'utf8').trim())
  if (Number.isSafeInteger(other) && other > 0 && other !== process.pid) {
    try {
      process.kill(other, 0)
      console.error(`${LOG_PREFIX} 已有一个 agent 在跑（pid ${other}），本次退出`)
      process.exit(0)
    } catch {
      /* 进程已不在，接管锁 */
    }
  }
}
writeFileSync(LOCK_PATH, String(process.pid), { mode: 0o600 })
process.on('exit', () => {
  try {
    if (readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_PATH)
  } catch {
    /* ignore */
  }
})

/** 复用到 dsh-pocket 的连接池：GUI 一次打开会有几十个静态资源请求。 */
const upstreamAgent = new HttpAgent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15_000 })

/**
 * DSH 桌面端每次重启都会换一套 dsh web 会话 token（cookie 名 `dsh-auth-<tokenId>`），
 * 手机里 30 天有效期的旧 cookie 于是永远对不上；而 pocket 见到 `dsh-auth-` 前缀就不再
 * 补 launch token，上游直接 401。转发前把过期的名字摘掉，让 pocket 重新握手。
 * 细节与来龙去脉见 dsh-auth.mjs。
 */
const dshAuth = createDshAuthFilter()

/**
 * 把 Cookie 头里名字过期的 dsh-auth-* 摘掉（没有可摘的就保持原样）。
 *
 * `requireKnown`：只在已经学到当前 cookie 名之后才动手。HTTP 不需要——摘掉就靠一次
 * 重握手自愈；WebSocket 握手没有「重放」的机会，名字还没学到时乱摘反而会把本来有效
 * 的会话打掉，所以那里要求先学到名字。
 */
function pruneStaleDshAuth(headers, { requireKnown = false } = {}) {
  if (requireKnown && dshAuth.names().length === 0) return
  const pruned = dshAuth.strip(headers.cookie)
  if (pruned === null) return
  if (pruned) headers.cookie = pruned
  else delete headers.cookie
}

// ---------------------------------------------------------------- dsh-pocket 登录

let pocketCookie = ''
let pocketLoginAt = 0
let pocketLoginInFlight = null

function readPocketPin() {
  try {
    return readFileSync(pocketPinFile, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 登录 dsh-pocket 拿它的会话 cookie。失败不致命（用户可能关掉了局域网密码）。
 * @param {boolean} [force]
 * @returns {Promise<string>}
 */
async function ensurePocketCookie(force = false) {
  if (!force && pocketCookie && Date.now() - pocketLoginAt < 30 * 60 * 1000) return pocketCookie
  if (pocketLoginInFlight) return pocketLoginInFlight

  pocketLoginInFlight = (async () => {
    const pin = readPocketPin()
    if (!pin) {
      log('没读到 pocket 的局域网密码文件；若上游要求鉴权会返回登录页')
      return pocketCookie
    }
    const body = new URLSearchParams({ token: pin }).toString()
    const result = await new Promise((resolve) => {
      const req = httpRequest(
        {
          host: upstreamHost,
          port: upstreamPort,
          path: '/pocket-login',
          method: 'POST',
          headers: {
            host: '127.0.0.1',
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
          },
          timeout: 8000,
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] ?? [] }))
        },
      )
      req.on('error', () => resolve({ status: 0, setCookie: [] }))
      req.on('timeout', () => {
        req.destroy()
        resolve({ status: 0, setCookie: [] })
      })
      req.end(body)
    })

    for (const raw of result.setCookie) {
      const pair = raw.split(';')[0]
      const idx = pair.indexOf('=')
      if (idx < 0) continue
      if (pair.slice(0, idx).trim() === 'dsh_pocket_token') {
        pocketCookie = pair.slice(idx + 1).trim()
        pocketLoginAt = Date.now()
      }
    }
    if (pocketCookie) log('pocket 登录成功')
    else log(`pocket 登录未取到 cookie（status ${result.status}）`)
    return pocketCookie
  })().finally(() => {
    pocketLoginInFlight = null
  })

  return pocketLoginInFlight
}

/**
 * 把浏览器的 Cookie 换成本机 pocket 认的那一份。
 * @param {Record<string, string>} headers
 * @param {string} cookie
 */
function withUpstreamCookie(headers, cookie) {
  const raw = headers.cookie ?? ''
  const kept = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('dsh_pocket_token='))
  if (cookie) kept.push(`dsh_pocket_token=${cookie}`)
  if (kept.length > 0) headers.cookie = kept.join('; ')
  else delete headers.cookie
}

// ---------------------------------------------------------------- 流

/**
 * @typedef {object} AgentStream
 * @property {'http'|'ws'} kind
 * @property {import('node:http').ClientRequest|null} req
 * @property {Buffer[]} pending
 * @property {boolean} ended
 * @property {number} sentBytes
 * @property {any} ws
 * @property {any} res
 */

/** @type {Map<number, AgentStream>} */
const streams = new Map()

/**
 * @param {number} id
 */
function dropStream(id) {
  const stream = streams.get(id)
  if (!stream) return
  streams.delete(id)
  try {
    stream.req?.destroy()
    stream.ws?.terminate?.() ?? stream.ws?.close?.()
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 文件预览

/** 允许预览的根目录：所有工作区 + 附件目录。别的一律拒绝。 */
let rootsCache = { at: 0, list: [] }

function allowedRoots() {
  const now = Date.now()
  if (now - rootsCache.at < 60_000 && rootsCache.list.length > 0) return rootsCache.list
  const roots = new Set()
  try {
    const store = JSON.parse(readFileSync(join(HOME, '.dsh', 'storages', 'workspace.json'), 'utf8'))
    for (const record of Object.values(store?.tables?.workspaces ?? {})) {
      if (typeof record?.path === 'string' && record.path.startsWith('/')) roots.add(record.path)
    }
  } catch {
    /* 没有工作区存储就只留附件目录 */
  }
  roots.add(join(HOME, '.dsh', 'attachments'))
  const list = []
  for (const root of roots) {
    try {
      list.push(realpathSync(root))
    } catch {
      /* 已删除的工作区跳过 */
    }
  }
  rootsCache = { at: now, list }
  return list
}

/** 判断真实路径是否在允许的根目录下。 */
function insideRoots(real) {
  for (const root of allowedRoots()) {
    if (real === root) return true
    if (real.startsWith(root + '/')) return true
  }
  return false
}

/**
 * 把聊天里看到的路径解析成真实文件。
 * @param {string} raw
 * @returns {{ file: string, size: number, name: string } | { error: string }}
 */
function resolvePreviewPath(raw) {
  const value = String(raw ?? '').trim()
  if (!value || value.includes('\0')) return { error: '路径为空' }
  if (value.length > 1024) return { error: '路径过长' }

  const relative = value.replace(/^\.\//, '')
  // 相对路径有两种常见写法：相对当前工作区（README.md），
  // 或带上了工作区目录名（P20/README.md）——两种都试，最后仍由 insideRoots 兜底。
  const candidates = value.startsWith('/')
    ? [value]
    : allowedRoots().flatMap((root) => {
        const list = [`${root}/${relative}`]
        const parent = root.slice(0, root.lastIndexOf('/'))
        if (parent) list.push(`${parent}/${relative}`)
        return list
      })

  let lastError = '文件不存在'
  for (const candidate of candidates) {
    let real
    try {
      real = realpathSync(candidate)
    } catch {
      continue
    }
    if (!insideRoots(real)) {
      lastError = '不允许访问这个路径'
      continue
    }
    try {
      const stat = statSync(real)
      if (!stat.isFile()) {
        lastError = '不是文件'
        continue
      }
      if (stat.size > 32 * 1024 * 1024) return { error: '文件太大（>32MB）' }
      return { file: real, size: stat.size, name: real.split('/').pop() ?? 'file' }
    } catch {
      lastError = '读取失败'
    }
  }
  return { error: lastError }
}

/**
 * 把文件流式发回 relay。
 * @param {{ id: number, path: string }} msg
 */
function sendFile(msg) {
  const { id } = msg
  const resolved = resolvePreviewPath(msg.path)
  if ('error' in resolved) {
    sendControl({ t: 'fsfail', id, message: resolved.error })
    return
  }
  sendControl({ t: 'fshead', id, size: resolved.size, name: resolved.name })
  const stream = createReadStream(resolved.file, { highWaterMark: 64 * 1024 })
  stream.on('data', (chunk) => {
    if (ws?.readyState !== 1) {
      stream.destroy()
      return
    }
    sendData(id, 0, chunk)
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      stream.pause()
      setTimeout(() => stream.resume(), 30)
    }
  })
  stream.on('end', () => sendControl({ t: 'fsend', id }))
  stream.on('error', (error) => sendControl({ t: 'fsfail', id, message: error.message }))
}

// ---------------------------------------------------------------- 连 relay

let ws = null
let reconnectDelay = 1000
let closedByUs = false
/** 最后一次收到对端任何字节的时间；用来发现「连接看着还在、其实已经死了」。 */
let lastSeen = 0

function connect() {
  const url = `${relayUrl.replace(/^http/, 'ws')}/__agent`
  log(`连接 ${relayUrl} …`)
  ws = new WebSocket(url, ['dsh-relay-v1', `auth.${token}`], {
    perMessageDeflate: false,
    handshakeTimeout: 15000,
    maxPayload: 64 * 1024 * 1024,
  })

  // DNS 卡住、TCP 黑洞这类情况 handshakeTimeout 兜不住（它只在 socket 建好后计时），
  // 所以再加一道总看门狗：20 秒还没 open 就放弃这条连接。
  const watchdog = setTimeout(() => {
    if (ws?.readyState !== 1) {
      log('连接超时，重来')
      try {
        ws?.terminate()
      } catch {
        /* ignore */
      }
    }
  }, 20_000)
  watchdog.unref?.()

  ws.on('open', () => {
    clearTimeout(watchdog)
    reconnectDelay = 1000
    lastSeen = Date.now()
    log('已连上 relay')
  })
  ws.on('pong', () => {
    lastSeen = Date.now()
  })

  ws.on('message', (data, isBinary) => {
    lastSeen = Date.now()
    if (isBinary) {
      handleDataFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
      return
    }
    try {
      handleControl(JSON.parse(String(data)))
    } catch (error) {
      log('控制帧解析失败', error)
    }
  })

  ws.on('close', (code, reason) => {
    log(`relay 断开 code=${code} ${reason?.toString?.() ?? ''}`)
    for (const id of [...streams.keys()]) dropStream(id)
    if (closedByUs) return
    if (code === 4000) {
      // 另一条 agent 连接把我们顶掉了（多半是双开），慢点再试
      setTimeout(connect, 5000)
      return
    }
    const delay = reconnectDelay
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    setTimeout(connect, delay + Math.floor(Math.random() * 500))
  })

  ws.on('error', (error) => log('relay socket 错误', error.message))
}

setInterval(() => {
  if (ws?.readyState !== 1) return
  // 75 秒一点声音都没有 → 判定连接已死，主动重连（NAT 超时、Wi-Fi 切网都走这条）。
  if (lastSeen && Date.now() - lastSeen > 75_000) {
    log('75 秒无响应，主动重连')
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
    return
  }
  ws.send(JSON.stringify({ t: 'ping', at: Date.now() }))
}, 25_000).unref()

// ---------------------------------------------------------------- 控制帧

/**
 * @param {Record<string, any>} msg
 */
function handleControl(msg) {
  switch (msg.t) {
    case 'hello':
      log('握手完成')
      return
    case 'pair':
      void onPairCode(msg.code, msg.expiresAt)
      return
    case 'ping':
      sendControl({ t: 'pong' })
      return
    case 'req':
      startHttp(msg)
      return
    case 'reqend': {
      const stream = streams.get(msg.id)
      if (!stream) return
      stream.ended = true
      stream.req?.end()
      return
    }
    case 'abort':
      dropStream(msg.id)
      return
    case 'wsopen':
      startWs(msg)
      return
    case 'fs':
      sendFile(msg)
      return
    case 'wsclose': {
      const stream = streams.get(msg.id)
      if (!stream) return
      try {
        stream.ws?.close(msg.code ?? 1000, msg.reason ?? '')
      } catch {
        /* ignore */
      }
      dropStream(msg.id)
      return
    }
    default:
      return
  }
}

/**
 * @param {Buffer} buf
 */
function handleDataFrame(buf) {
  if (buf.length < 5) return
  const id = buf.readUInt32BE(0)
  const kind = buf.readUInt8(4)
  const payload = buf.subarray(5)
  const stream = streams.get(id)
  if (!stream) return

  if (stream.kind === 'http') {
    stream.sentBytes += payload.length
    if (stream.req) stream.req.write(payload)
    else stream.pending.push(Buffer.from(payload))
    return
  }

  if (stream.ws?.readyState === 1) stream.ws.send(payload, { binary: kind === 2 })
}

function sendControl(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg))
}

function sendData(id, kind, payload) {
  if (ws?.readyState !== 1) return
  const head = Buffer.allocUnsafe(5)
  head.writeUInt32BE(id >>> 0, 0)
  head.writeUInt8(kind, 4)
  ws.send(Buffer.concat([head, payload]), { binary: true })
}

// ---------------------------------------------------------------- HTTP 转发

/** 过滤掉不能透传的请求头。 */
function cleanHeaders(input) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, value] of Object.entries(input ?? {})) {
    const lower = name.toLowerCase()
    if (lower.startsWith('proxy-')) continue
    if (['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'].includes(lower)) continue
    // WebSocket 握手头是逐跳的：转发给上游会和 ws 客户端自己生成的那一套打架
    // （重复的 Sec-WebSocket-Key / Version，以及我们已禁用的 permessage-deflate 扩展）。
    if (lower.startsWith('sec-websocket-')) continue
    out[lower] = String(value)
  }
  return out
}

/**
 * 把 relay 转来的一条 HTTP 请求打到 pocket。
 * 注意：请求头与 body 可能比 pocket 登录（异步）更早到，所以先登记流、把 body 排队。
 *
 * `options.ended`：重放用。relay 只会在第一轮发一次 `reqend`，重放出来的流等不到它，
 * 请求就永远不会 end（上游不响应、手机一直转圈），所以重放时直接当 body 已经发完。
 * @param {{ id: number, method: string, url: string, headers: Record<string, string> }} msg
 * @param {number} [attempt]
 * @param {{ ended?: boolean }} [options]
 */
function startHttp(msg, attempt = 0, options = {}) {
  const id = msg.id
  /** @type {AgentStream} */
  const stream = { kind: 'http', req: null, pending: [], ended: options.ended === true, sentBytes: 0, ws: null, res: null }
  streams.set(id, stream)

  void (async () => {
    const cookie = await ensurePocketCookie()
    if (!streams.has(id)) return

    const headers = cleanHeaders(msg.headers)
    withUpstreamCookie(headers, cookie)
    pruneStaleDshAuth(headers)
    headers.host = `${upstreamHost}:${upstreamPort}`
    if (headers.origin) headers.origin = `http://${upstreamHost}:${upstreamPort}`
    if (headers.referer) {
      try {
        headers.referer = `http://${upstreamHost}:${upstreamPort}${new URL(headers.referer).pathname}`
      } catch {
        delete headers.referer
      }
    }
    headers['accept-encoding'] = 'gzip, deflate, br'

    if (DEBUG) log(`→ ${msg.method} ${msg.url}`, JSON.stringify(headers))

    const req = httpRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        path: msg.url,
        method: msg.method,
        headers,
        agent: upstreamAgent,
      },
      (res) => {
        if (!streams.has(id)) {
          res.destroy()
          return
        }
        stream.res = res
        // 上游握手成功会下发当前会话的 dsh-auth-<tokenId>，记住这个名字，
        // 后面的请求就能把名字对不上的旧 cookie 丢掉（dsh-auth.mjs）。
        dshAuth.note(res.headers['set-cookie'])

        // 上游 401 的纯文本就是 dsh web 的「会话 cookie 未通过」。DSH 重启会换一套
        // tokenId，而手机里那个旧名字可能正好等于我们上次学到的名字——过滤不会碰它，
        // pocket 见到 `dsh-auth-` 前缀也不再补 launch token，于是每次刷新都还是 401。
        // 解法：把学到的名字作废，摘掉 dsh-auth-* 后原样重放一次，让 pocket 重新握手。
        let replaying = false
        if (res.statusCode === 401 && /text\/plain/i.test(String(res.headers['content-type'] ?? ''))) {
          log(`上游 401 ${msg.method} ${msg.url}：dsh web 会话 cookie 未通过`)
          if (attempt === 0 && stream.sentBytes === 0 && (msg.method === 'GET' || msg.method === 'HEAD')) {
            replaying = true
            dshAuth.reset()
            dshAuth.note(res.headers['set-cookie'])
            log(`作废旧会话名，摘掉 dsh-auth-* 后重放 ${msg.method} ${msg.url}`)
            res.destroy()
            streams.delete(id)
            setTimeout(() => startHttp(msg, attempt + 1, { ended: true }), 50)
            return
          }
        }
        sendControl({ t: 'upstream', down: false })
        sendControl({ t: 'res', id, status: res.statusCode, statusText: res.statusMessage, headers: res.headers })

        // pocket 的登录页会在 DSH 重启后出现（它把 cookie 绑在进程级 sessionKey 上）。
        // 嗅到就丢掉这次响应、强制重新登录、把同一请求重放一次。
        const isHtml = /text\/html/i.test(String(res.headers['content-type'] ?? ''))
        let sniffed = false
        let sniffBuf = Buffer.alloc(0)
        const reLogin = (chunk) => {
          if (sniffed || !isHtml || attempt > 0) return false
          if (msg.method !== 'GET' && msg.method !== 'HEAD') return false
          sniffBuf = Buffer.concat([sniffBuf, chunk])
          if (sniffBuf.length < 4096 && !/访问验证|access PIN|dsh-pocket-auth/i.test(sniffBuf.toString('utf8'))) return false
          if (!/访问验证|access PIN|dsh-pocket-auth/i.test(sniffBuf.toString('utf8'))) return false
          sniffed = true
          return true
        }
        res.on('data', (chunk) => {
          if (replaying) return
          if (reLogin(chunk)) {
            log('pocket 会话失效，重新登录后重放请求')
            res.destroy()
            void ensurePocketCookie(true).then(() => {
              streams.delete(id)
              startHttp(msg, attempt + 1, { ended: true })
            })
            return
          }
          sendData(id, 0, chunk)
        })
        res.on('end', () => {
          sendControl({ t: 'resend', id })
          streams.delete(id)
        })
        res.on('error', () => {
          if (replaying) return
          sendControl({ t: 'error', id, message: 'upstream response error' })
          dropStream(id)
        })
      },
    )

    stream.req = req

    req.on('error', (error) => {
      const code = error.code ?? error.message
      const sent = stream.sentBytes
      const retryable =
        (code === 'ECONNRESET' || code === 'EPIPE') &&
        attempt === 0 &&
        sent === 0 &&
        (msg.method === 'GET' || msg.method === 'HEAD')
      dropStream(id)
      if (retryable) {
        log(`重试 ${msg.method} ${msg.url}（${code}）`)
        setTimeout(() => startHttp(msg, attempt + 1, { ended: true }), 80)
        return
      }
      log(`上游失败 ${msg.method} ${msg.url} → ${code}`)
      if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') {
        sendControl({ t: 'upstream', down: true, reason: code })
      }
      sendControl({ t: 'error', id, message: `upstream connect failed: ${code}` })
    })

    for (const chunk of stream.pending) req.write(chunk)
    stream.pending.length = 0
    if (stream.ended) req.end()
  })()
}

// ---------------------------------------------------------------- WebSocket 转发

/**
 * @param {{ id: number, url: string, headers: Record<string, string>, protocol?: string }} msg
 */
function startWs(msg) {
  const id = msg.id
  /** @type {AgentStream} */
  const stream = { kind: 'ws', req: null, pending: [], ended: false, sentBytes: 0, ws: null, res: null }
  streams.set(id, stream)

  void (async () => {
    const cookie = await ensurePocketCookie()
    if (!streams.has(id)) return

    const headers = cleanHeaders(msg.headers)
    withUpstreamCookie(headers, cookie)
    pruneStaleDshAuth(headers, { requireKnown: true })
    headers.host = `${upstreamHost}:${upstreamPort}`
    headers.origin = `http://${upstreamHost}:${upstreamPort}`

    // 浏览器可能一次给多个子协议，pocket/DSH 只认自己的那套；原样传即可。
    const protocols = String(msg.protocol ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    if (DEBUG) log(`→ WS ${msg.url}`, JSON.stringify(headers))

    const client = new WebSocket(`ws://${upstreamHost}:${upstreamPort}${msg.url}`, protocols.length > 0 ? protocols : undefined, {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: 15000,
    })
    stream.ws = client
    client.on('upgrade', (res) => dshAuth.note(res.headers['set-cookie']))

    client.on('open', () => sendControl({ t: 'wsopened', id }))
    client.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      sendData(id, isBinary ? 2 : 1, buf)
    })
    client.on('close', (code, reason) => {
      sendControl({ t: 'wsclose', id, code, reason: reason?.toString?.() ?? '' })
      streams.delete(id)
    })
    client.on('error', (error) => {
      log(`上游 WS 失败 ${msg.url} → ${error.message}`)
      // 401 = dsh web 换了 tokenId；把学到的名字作废，等下一次 HTTP 请求重新握手。
      if (/\b401\b/.test(error.message)) dshAuth.reset()
      sendControl({ t: 'error', id, message: `upstream ws failed: ${error.message}` })
      dropStream(id)
    })
  })()
}

// ---------------------------------------------------------------- 配对码

/**
 * relay 推来新配对码：写文件 + 尽量生成二维码。
 * @param {string} code
 * @param {number} expiresAt
 */
async function onPairCode(code, expiresAt) {
  if (!code) return
  const url = `${relayUrl}/__pair?code=${encodeURIComponent(code)}`
  mkdirSync(dirname(PAIR_PATH), { recursive: true })
  writeFileSync(
    PAIR_PATH,
    `${url}\n配对码：${code}\n有效期至：${new Date(expiresAt).toLocaleString('zh-CN')}\n`,
    { mode: 0o600 },
  )
  log(`新配对码 ${code} → ${PAIR_PATH}`)
  try {
    const { default: QRCode } = await import('qrcode')
    const out = join(dirname(PAIR_PATH), 'pair.png')
    await QRCode.toFile(out, url, { width: 720, margin: 2, errorCorrectionLevel: 'M' })
    log(`二维码已更新 ${out}`)
  } catch {
    /* 没装 qrcode 就只留文字 */
  }
}

// ---------------------------------------------------------------- 启动

void ensurePocketCookie().catch(() => {})
connect()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closedByUs = true
    try {
      ws?.close(1000, 'agent shutdown')
    } catch {
      /* ignore */
    }
    process.exit(0)
  })
}

process.on('uncaughtException', (error) => log('uncaught', error))
process.on('unhandledRejection', (error) => log('unhandled', error))
