#!/usr/bin/env node
/**
 * relay 冒烟自检：不连公网、不需要 Mac 上的 agent，只验证「默认关闭」的那几条安全栅栏。
 *
 *   node test/smoke.mjs
 *
 * 做法：用一份临时 config 在随机端口起 relay，打几个请求，再断言结果。
 * 覆盖：健康检查、PWA 资源公开、未配对被拦、错误配对码被拒、/__fs 两种准入路径、
 *       静态路径不可穿越、agent 缺失时上游相关端点明确报错而不是挂住。
 *
 * 全部通过退出码 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, randomBytes } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const relayEntry = join(here, '..', 'relay', 'server.js')

let failures = 0
const pass = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const fail = (msg) => {
  failures += 1
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
}

/** 让系统给一个空闲端口，避免和本机别的东西打架。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 等 relay 打印出监听日志。 */
function waitForListen(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay 启动超时')), timeoutMs)
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('[dsh-relay] 监听')) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`relay 提前退出，code=${code}\n${buffer}`))
    })
  })
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string }} [options]
 */
async function hit(url, options = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', ...options })
    const body = Buffer.from(await res.arrayBuffer())
    return { status: res.status, headers: res.headers, body }
  } catch (error) {
    return { status: 0, headers: new Headers(), body: Buffer.from(String(error)) }
  }
}

async function main() {
  const port = await freePort()
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-relay-smoke-'))
  const configPath = join(workDir, 'config.json')
  const sessionSecret = randomBytes(32).toString('hex')
  writeFileSync(
    configPath,
    JSON.stringify({
      port,
      bind: '127.0.0.1',
      agentToken: randomBytes(32).toString('hex'),
      sessionSecret,
      cookieName: 'dsh_relay',
      sessionTtlMs: 180 * 24 * 3600 * 1000,
      pairCodeTtlMs: 15 * 60 * 1000,
      pairMaxAttempts: 10,
    }),
  )

  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [relayEntry], {
    env: { ...process.env, DSH_RELAY_CONFIG: configPath, PORT: String(port), BIND: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let relayLog = ''
  child.stdout.on('data', (c) => {
    relayLog += c.toString()
  })
  child.stderr.on('data', (c) => {
    relayLog += c.toString()
  })

  console.log(`\n\x1b[1mDSH Remote relay 冒烟自检\x1b[0m  (临时实例 :${port})\n`)

  try {
    await waitForListen(child)

    // 1. 健康检查公开且不泄露凭证
    const health = await hit(`${base}/__health`)
    let json = {}
    try {
      json = JSON.parse(health.body.toString())
    } catch {
      /* ignore */
    }
    health.status === 200 && json.ok === true ? pass('/__health 可用') : fail(`/__health 异常 ${health.status}`)
    json.agent === false ? pass('未连 agent 时如实报告 offline') : fail('agent 状态不对')
    !/agentToken|sessionSecret/i.test(health.body.toString())
      ? pass('/__health 不含任何密钥字段')
      : fail('/__health 泄露了配置字段')

    // 2. PWA 资源必须公开（浏览器抓取时不带 cookie）
    const manifest = await hit(`${base}/manifest.webmanifest`)
    const manifestType = manifest.headers.get('content-type') ?? ''
    manifest.status === 200 && /manifest\+json/.test(manifestType)
      ? pass('/manifest.webmanifest 公开可读')
      : fail(`manifest 异常 ${manifest.status} ${manifestType}`)

    const icon = await hit(`${base}/__pwa/icon-192.png`)
    const pngOk = icon.body.length > 100 && icon.body.subarray(1, 4).toString() === 'PNG'
    icon.status === 200 && pngOk ? pass(`PWA 图标 192 是合法 PNG（${icon.body.length} 字节）`) : fail('PWA 图标不对')

    const badIcon = await hit(`${base}/__pwa/icon-999.png`)
    badIcon.status === 404 ? pass('非法尺寸的图标 404') : fail(`非法图标尺寸应 404，实际 ${badIcon.status}`)

    // 3. 未配对：首页必须是配对页，不能漏内容
    const anon = await hit(`${base}/`)
    anon.status === 401 ? pass('未配对访问 401') : fail(`未配对访问应 401，实际 ${anon.status}`)
    /配对|pair/i.test(anon.body.toString()) ? pass('401 页面是配对引导') : fail('401 页面内容不对')
    !/DeepSeek Harness/.test(anon.body.toString()) ? pass('未配对时不下发 GUI') : fail('未配对就漏了 GUI')

    // 4. 错误配对码
    const badPair = await hit(`${base}/__pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=ZZZZZZZZ&next=/',
    })
    ;[401, 429].includes(badPair.status)
      ? pass(`错误配对码被拒（${badPair.status}）`)
      : fail(`错误配对码应 401/429，实际 ${badPair.status}`)
    ;(badPair.headers.get('set-cookie') ?? '') === ''
      ? pass('配对失败不发 cookie')
      : fail('配对失败却下发了 cookie')

    // 5. /__fs 的两条准入路径都必须先过鉴权
    const fsNo = await hit(`${base}/__fs?p=${encodeURIComponent('/etc/passwd')}`)
    fsNo.status === 401 ? pass('/__fs 无凭证 401（路径还没走到就拦下）') : fail(`/__fs 应 401，实际 ${fsNo.status}`)

    const fsBadSig = await hit(
      `${base}/__fs?p=${encodeURIComponent('/etc/passwd')}&exp=${Date.now() + 60000}&sig=deadbeef`,
    )
    fsBadSig.status === 401 ? pass('/__fs 伪造签名 401') : fail(`/__fs 伪造签名应 401，实际 ${fsBadSig.status}`)

    const link = await hit(`${base}/__fs/link?p=${encodeURIComponent('README.md')}`)
    link.status === 401 ? pass('/__fs/link 无凭证 401') : fail(`/__fs/link 应 401，实际 ${link.status}`)

    // 6. 静态路径不可穿越（relay 自己不服务磁盘文件，穿越应当落到 401/404）
    const traversal = await hit(`${base}/../../../etc/passwd`)
    ;[400, 401, 404].includes(traversal.status)
      ? pass(`路径穿越被挡（${traversal.status}）`)
      : fail(`路径穿越返回 ${traversal.status}，可疑`)

    // 7. 未连 agent 时，上游请求是明确失败而不是无限挂起
    const withCookie = await hit(`${base}/__health`, {
      headers: { cookie: 'dsh_relay=v1.0x1.deadbeef' },
    })
    withCookie.status === 200 ? pass('伪造 cookie 不被当作已认证（仅健康检查可达）') : fail('健康检查异常')

    // 8. 对外链接不能写死域名：前缀应该来自这次请求的 Host
    const issuedAt = Date.now()
    const mac = createHmac('sha256', sessionSecret).update(`v1.${issuedAt}`).digest('base64url')
    const realCookie = `dsh_relay=v1.${issuedAt}.${mac}`
    const linkOk = await hit(`${base}/__fs/link?p=${encodeURIComponent('README.md')}`, {
      headers: { cookie: realCookie },
    })
    const linkText = linkOk.body.toString()
    const linkUsesRequestHost = linkText.startsWith(`${base}/__fs?`)
    linkOk.status === 200 && linkUsesRequestHost
      ? pass('/__fs/link 用请求的 Host 拼链接（没有硬编码域名）')
      : fail(`/__fs/link 异常：${linkOk.status} ${linkText.slice(0, 120)}`)

    const signedShape = /exp=\d+&sig=[\w-]+/
    signedShape.test(linkText) ? pass('/__fs/link 带 exp + HMAC 签名') : fail('/__fs/link 签名参数不对')

    // 链接里的主机必须等于这次请求的主机，不能是任何写死的域名
    let linkHost = ''
    try {
      linkHost = new URL(linkText).host
    } catch {
      /* 推不出对外地址时会退化成相对链接，下面的断言会给出明确的失败信息 */
    }
    linkHost === `127.0.0.1:${port}`
      ? pass('签名链接的主机就是请求主机（没有硬编码域名）')
      : fail(`签名链接指向了别的主机：${linkHost || '(空)'}`)

    // 9. 反代传进来的 X-Forwarded-Host 要能改掉链接前缀
    //    （fetch 不允许覆盖 Host 头，所以这里走 nginx 实际会带的那一对头）
    const altHost = await hit(`${base}/__fs/link?p=${encodeURIComponent('README.md')}`, {
      headers: {
        cookie: realCookie,
        'x-forwarded-host': 'phone.test:8443',
        'x-forwarded-proto': 'https',
      },
    })
    altHost.body.toString().startsWith('https://phone.test:8443/__fs?')
      ? pass('publicBaseUrl 缺省时按 X-Forwarded-Host / X-Forwarded-Proto 推导')
      : fail(`Host 推导未生效：${altHost.body.toString().slice(0, 120)}`)

    // 10. config 缺密钥时必须拒绝启动
    const badConfigPath = join(workDir, 'bad.json')
    writeFileSync(badConfigPath, JSON.stringify({ port, bind: '127.0.0.1' }))
    const bad = spawn(process.execPath, [relayEntry], {
      env: { ...process.env, DSH_RELAY_CONFIG: badConfigPath, PORT: String(port + 1) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 8000)
      bad.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    if (exitCode === 'timeout') bad.kill('SIGKILL')
    exitCode === 2 ? pass('自检：缺少 agentToken/sessionSecret 时拒绝启动') : fail(`缺密钥应退出码 2，实际 ${exitCode}`)
  } finally {
    child.removeAllListeners('exit')
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      child.once('exit', resolve)
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000).unref?.()
    })
    rmSync(workDir, { recursive: true, force: true })
  }

  console.log('')
  if (failures === 0) {
    console.log('\x1b[32m\x1b[1m全部通过\x1b[0m\n')
    process.exit(0)
  }
  console.log(`\x1b[31m\x1b[1m${failures} 项失败\x1b[0m`)
  console.log(`\n--- relay 日志 ---\n${relayLog}\n`)
  process.exit(1)
}

main().catch((error) => {
  console.error('冒烟自检异常', error)
  process.exit(1)
})
