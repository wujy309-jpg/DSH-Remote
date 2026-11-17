import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshAuthFilter, cookieNameOf, DSH_AUTH_PREFIX } from '../agent/dsh-auth.mjs'

const OLD = 'dsh-auth-OLDoldOLDold=v1.eyJ2ZXJzaW9uIjoxfQ.deadbeef'
const CURRENT = 'dsh-auth-sJ1bCMgxTKuXdsB_I41eueTHPhkOevaeEGwYT8YIO54=v1.eyJ2ZXJzaW9uIjoxfQ.live'
const CURRENT_NAME = 'dsh-auth-sJ1bCMgxTKuXdsB_I41eueTHPhkOevaeEGwYT8YIO54'

test('cookieNameOf 拆得开 name=value，坏输入返回空串', () => {
  assert.equal(cookieNameOf(OLD), 'dsh-auth-OLDoldOLDold')
  assert.equal(cookieNameOf('novalue'), '')
  assert.equal(cookieNameOf('=x'), '')
  assert.equal(cookieNameOf(undefined), '')
})

test('note 只认 dsh-auth-*，忽略其它 set-cookie（含数组）', () => {
  const filter = createDshAuthFilter()
  filter.note([
    'dsh_pocket_token=abc; HttpOnly; Path=/',
    `${CURRENT}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
  ])
  assert.deepEqual(filter.names(), [CURRENT_NAME])
})

test('agent 刚起来还没学到名字时，旧 cookie 一律摘掉（靠一次重握手自愈）', () => {
  const filter = createDshAuthFilter()
  assert.equal(filter.strip(`dsh_pocket_token=abc; ${OLD}`), 'dsh_pocket_token=abc')
})

test('完全没有 dsh-auth-* 的请求 strip 返回 null（不碰其它 cookie）', () => {
  const filter = createDshAuthFilter()
  assert.equal(filter.strip('dsh_pocket_token=abc; theme=dark'), null)
  assert.equal(filter.strip(''), null)
})

test('学到了当前名字之后，旧名字被摘掉，其它 cookie 原样保留', () => {
  const filter = createDshAuthFilter()
  filter.note(`${CURRENT}; Path=/`)
  assert.equal(
    filter.strip(`dsh_pocket_token=abc; ${OLD}; ${CURRENT}; theme=dark`),
    `dsh_pocket_token=abc; ${CURRENT}; theme=dark`,
  )
})

test('名字对得上时 strip 返回 null（不动请求，省得每次导航都重握手）', () => {
  const filter = createDshAuthFilter()
  filter.note(`${CURRENT}; Path=/`)
  assert.equal(filter.strip(`dsh_pocket_token=abc; ${CURRENT}`), null)
})

test('DSH 重启换了一整套 cookie → 旧名字作废、新名字受认可', () => {
  const filter = createDshAuthFilter()
  filter.note(`${CURRENT}; Path=/`)
  const restarted = 'dsh-auth-NEWnewNEWnew=v1.eyJ2ZXJzaW9uIjoxfQ.fresh'
  filter.note(`${restarted}; Path=/`)
  assert.deepEqual(filter.names(), ['dsh-auth-NEWnewNEWnew'])
  // 浏览器里旧名字还在 → 必须摘掉，pocket 才会补 launch token
  assert.equal(filter.strip(`dsh_pocket_token=abc; ${OLD}; ${CURRENT}`), 'dsh_pocket_token=abc')
  // 新 cookie 到手后不再动
  assert.equal(filter.strip(`dsh_pocket_token=abc; ${restarted}`), null)
})

test('全部 dsh-auth-* 都是旧的时候，strip 返回空串（调用方要删除 Cookie 头）', () => {
  const filter = createDshAuthFilter()
  filter.note(`${CURRENT}; Path=/`)
  assert.equal(filter.strip(OLD), '')
})

test('reset 之后名字作废：下一个请求把 dsh-auth-* 全部摘掉（401 自愈路径）', () => {
  const filter = createDshAuthFilter()
  filter.note(`${CURRENT}; Path=/`)
  assert.equal(filter.strip(`dsh_pocket_token=abc; ${CURRENT}`), null)
  filter.reset()
  assert.deepEqual(filter.names(), [])
  assert.equal(filter.strip(`dsh_pocket_token=abc; ${CURRENT}`), 'dsh_pocket_token=abc')
})

test('前缀常量与 dsh web 实际下发的一致', () => {
  assert.ok(CURRENT.startsWith(DSH_AUTH_PREFIX))
})
