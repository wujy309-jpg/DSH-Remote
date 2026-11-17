#!/usr/bin/env node
/**
 * 端到端自检：把 relay 当成手机浏览器，走完「配对 → 拿 cookie → 取 GUI → 取静态资源 → 开 WebSocket」。
 *
 *   node e2e.mjs http://127.0.0.1:8848 <配对码>
 *
 * 全部通过时退出码 0；任何一步不对都会打印原因并退出 1。
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { WebSocket } from 'ws'

const base = (process.argv[2] ?? 'http://127.0.0.1:8848').replace(/\/+$/, '')
const pairCode = process.argv[3] ?? ''
const isHttps = base.startsWith('https:')
const want = new URL(base)

let failures = 0
const pass = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const fail = (msg) => {
  failures += 1
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
}

/**
 * 发一个请求，收完整响应。
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string,string>, body?: string, cookie?: string }} [options]
 */
function fetchPath(path, options = {}) {
  const { method = 'GET', headers = {}, body, cookie } = options
  const send = isHttps ? httpsRequest : httpRequest
  return new Promise((resolve) => {
    const req = send(
      {
        host: want.hostname,
        port: want.port || (isHttps ? 443 : 80),
        path,
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
        rejectUnauthorized: false,
        timeout: 20000,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', (error) => resolve({ status: 0, headers: {}, body: Buffer.from(String(error.message)), error }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, headers: {}, body: Buffer.from('timeout') })
    })
    req.end(body)
  })
}

const setCookies = (res) => res.headers['set-cookie'] ?? []
const cookiePairs = (res) => setCookies(res).map((s) => s.split(';')[0])

async function main() {
  console.log(`\n\x1b[1mDSH Remote 端到端自检\x1b[0m  ${base}\n`)

  // 1. 未配对访问
  const anon = await fetchPath('/')
  anon.status === 401 && /配对|pair/i.test(anon.body.toString())
    ? pass('未配对访问被拦到登录页')
    : fail(`未配对访问应 401 + 登录页，实际 ${anon.status}`)

  // 2. 健康检查
  const health = await fetchPath('/__health')
  let healthJson = {}
  try {
    healthJson = JSON.parse(health.body.toString())
  } catch {
    /* ignore */
  }
  healthJson.ok === true ? pass('relay 健康检查通过') : fail(`relay /__health 异常：${health.body.toString().slice(0, 120)}`)
  healthJson.agent === true ? pass('Mac agent 在线') : fail('Mac agent 未连接')

  // 3. 错误配对码
  const badPair = await fetchPath('/__pair', { method: 'POST', body: 'code=ZZZZZZZZ&next=/' })
  badPair.status === 401
    ? pass('错误配对码被拒绝')
    : badPair.status === 429
      ? pass('错误配对码被限速拦截（429）')
      : fail(`错误配对码应 401/429，实际 ${badPair.status}`)

  if (!pairCode) {
    fail('没有提供配对码，跳过后续（relay 的配对码在日志里）')
    return finish()
  }

  // 4. 正确配对
  const pair = await fetchPath('/__pair', { method: 'POST', body: `code=${pairCode}&next=/` })
  const relayCookie = cookiePairs(pair).find((c) => c.startsWith('dsh_relay='))
  pair.status === 200 && relayCookie ? pass('配对成功，拿到会话 cookie') : fail(`配对失败：${pair.status}`)

  // 5. 首跳：pocket 的 launch-token 握手
  const hop1 = await fetchPath('/', { cookie: relayCookie })
  const dshCookie = cookiePairs(hop1).find((c) => c.startsWith('dsh-auth-'))
  hop1.status === 200 ? pass(`首跳返回 ${hop1.body.length} 字节`) : fail(`首跳异常 ${hop1.status}`)
  dshCookie ? pass('拿到 DSH 会话 cookie') : fail('没拿到 DSH 会话 cookie（上游鉴权没通）')

  const cookie = [relayCookie, dshCookie].filter(Boolean).join('; ')

  // 6. 真正的 GUI
  const home = await fetchPath('/', { cookie })
  const html = home.body.toString()
  home.status === 200 && /<title>DeepSeek Harness<\/title>/.test(html)
    ? pass(`GUI 首屏 ${home.body.length} 字节`)
    : fail(`GUI 首屏不对：${home.status} ${html.slice(0, 120)}`)

  // 7. 静态资源（从 HTML 里挑一个 script）
  const scriptMatch = html.match(/src="([^"]*client\.js[^"]*)"/) ?? html.match(/src="([^"]+\.js[^"]*)"/)
  if (scriptMatch) {
    const raw = scriptMatch[1].replaceAll('&amp;', '&')
    const assetPath = raw.startsWith('/') ? raw : `/${raw}`
    const asset = await fetchPath(assetPath, { cookie })
    asset.status === 200 && asset.body.length > 1000
      ? pass(`静态资源 ${assetPath.slice(0, 48)}… ${asset.body.length} 字节`)
      : fail(`静态资源失败 ${assetPath} → ${asset.status} / ${asset.body.length}B`)
  } else {
    fail('HTML 里没找到 script 标签')
  }

  // 8. WebSocket 穿透
  await new Promise((resolve) => {
    const wsUrl = `${isHttps ? 'wss' : 'ws'}://${want.host}/api/remote.mux`
    let settled = false
    const done = (ok, msg) => {
      if (settled) return
      settled = true
      ok ? pass(msg) : fail(msg)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve()
    }
    const ws = new WebSocket(wsUrl, {
      headers: { cookie, origin: `${isHttps ? 'https' : 'http'}://${want.host}` },
      rejectUnauthorized: false,
    })
    ws.on('open', () => done(true, 'WebSocket 握手成功'))
    ws.on('unexpected-response', (_req, res) => done(false, `WebSocket 被拒：HTTP ${res.statusCode}`))
    ws.on('error', (error) => done(false, `WebSocket 错误：${error.message}`))
    setTimeout(() => done(false, 'WebSocket 8 秒未建立'), 8000)
  })

  finish()
}

function finish() {
  console.log('')
  if (failures === 0) {
    console.log('\x1b[32m\x1b[1m全部通过\x1b[0m\n')
    process.exit(0)
  }
  console.log(`\x1b[31m\x1b[1m${failures} 项失败\x1b[0m\n`)
  process.exit(1)
}

main().catch((error) => {
  console.error('自检脚本异常', error)
  process.exit(1)
})
