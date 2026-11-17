/**
 * DSH Remote — 手机遥控通道
 * 线上协议：relay（公网服务器） ⇄ agent（你的 Mac），单条 WSS 上多路复用 HTTP + WebSocket。
 *
 * 控制帧用 JSON 文本帧；数据帧用二进制帧，头部固定 5 字节：
 *   [id: uint32 BE][kind: uint8][payload...]
 *   kind 0 = HTTP body（方向由该流的当前状态决定）
 *   kind 1 = WebSocket text 消息（payload 为 utf8）
 *   kind 2 = WebSocket binary 消息
 */

export const KIND_HTTP = 0
export const KIND_WS_TEXT = 1
export const KIND_WS_BIN = 2

/** 每个流最多在内存里积压的字节数，超了就掐掉，避免把 1.8G 的小机器打爆。 */
export const MAX_STREAM_BUFFER = 8 * 1024 * 1024

/** 单条 HTTP 流的生命周期上限。 */
export const HTTP_STREAM_TIMEOUT_MS = 15 * 60 * 1000

/** 逐跳头部：这些不能透传给上游，也不能回传给浏览器。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * 过滤逐跳头部。
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {Record<string, string>}
 */
export function stripHopByHop(headers) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

/**
 * 拼一帧数据。
 * @param {number} id
 * @param {number} kind
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function dataFrame(id, kind, payload) {
  const head = Buffer.allocUnsafe(5)
  head.writeUInt32BE(id >>> 0, 0)
  head.writeUInt8(kind, 4)
  return Buffer.concat([head, payload])
}

/**
 * 拆一帧数据。
 * @param {Buffer} buf
 * @returns {{ id: number, kind: number, payload: Buffer }}
 */
export function parseDataFrame(buf) {
  if (buf.length < 5) throw new Error('data frame too short')
  return {
    id: buf.readUInt32BE(0),
    kind: buf.readUInt8(4),
    payload: buf.subarray(5),
  }
}
