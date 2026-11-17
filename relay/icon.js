/**
 * 极简 PNG 生成：只为了给「添加到主屏幕」一张体面的图标，不引第三方依赖。
 *
 * 画布是 8bit RGBA、无隔行、filter 0；用 node:zlib 压 IDAT。
 * 图形：圆角方块 + 蓝紫渐变 + 白色终端提示符（>_）。
 */

import { deflateSync } from 'node:zlib'

/** CRC32（PNG 分块校验）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * 把 RGBA 像素数组编码成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度 width*height*4
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 圆角矩形的内部判定（超采样抗锯齿在 drawIcon 里做）。 */
function insideRoundedRect(x, y, size, radius) {
  const r = radius
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 线段距离（用于画提示符笔画）。 */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy || 1
  const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2))
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * 画一张图标。
 * @param {number} size 边长（正方形）
 * @param {boolean} [maskable] 是否给 Android 的 maskable 版本（内容缩进到安全区）
 * @returns {Buffer} PNG
 */
export function drawIcon(size, maskable = false) {
  const rgba = new Uint8Array(size * size * 4)
  const radius = size * (maskable ? 0.5 : 0.22)
  const inset = maskable ? size * 0.14 : 0
  const art = size - inset * 2
  // 提示符笔画：相对画布的位置
  const cx = size / 2
  const cy = size / 2
  const w = art * 0.5
  const h = art * 0.34
  const stroke = Math.max(2, art * 0.075)
  const chevX0 = cx - w * 0.42
  const chevY0 = cy - h * 0.5
  const chevX1 = cx - w * 0.08
  const chevY1 = cy
  const chevX2 = chevX0
  const chevY2 = cy + h * 0.5
  const lineX0 = cx + w * 0.02
  const lineX1 = cx + w * 0.46
  const lineY = cy + h * 0.5

  const SS = 3 // 超采样 3x3

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0
      let fgHits = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          if (!insideRoundedRect(px, py, size, radius)) continue
          bgHits += 1
          const d = Math.min(
            distToSegment(px, py, chevX0, chevY0, chevX1, chevY1),
            distToSegment(px, py, chevX1, chevY1, chevX2, chevY2),
            distToSegment(px, py, lineX0, lineY, lineX1, lineY),
          )
          if (d <= stroke / 2) fgHits += 1
        }
      }
      const total = SS * SS
      const idx = (y * size + x) * 4
      if (bgHits === 0) {
        rgba[idx + 3] = 0
        continue
      }
      // 渐变：左上偏蓝 → 右下偏紫
      const t = Math.min(1, Math.max(0, (x / size) * 0.55 + (y / size) * 0.45))
      let r = Math.round(77 + (139 - 77) * t)
      let g = Math.round(107 + (92 - 107) * t)
      let b = Math.round(254 + (246 - 254) * t)
      const fgAlpha = fgHits / total
      if (fgAlpha > 0) {
        r = Math.round(r * (1 - fgAlpha) + 255 * fgAlpha)
        g = Math.round(g * (1 - fgAlpha) + 255 * fgAlpha)
        b = Math.round(b * (1 - fgAlpha) + 255 * fgAlpha)
      }
      rgba[idx] = r
      rgba[idx + 1] = g
      rgba[idx + 2] = b
      rgba[idx + 3] = Math.round((bgHits / total) * 255)
    }
  }

  return encodePng(size, size, rgba)
}

/** 进程内缓存：同一尺寸只画一次。 */
const cache = new Map()

/**
 * 取一张图标 PNG（带缓存）。
 * @param {number} size
 * @param {boolean} [maskable]
 * @returns {Buffer}
 */
export function iconPng(size, maskable = false) {
  const key = `${size}:${maskable ? 'm' : 'n'}`
  if (!cache.has(key)) cache.set(key, drawIcon(size, maskable))
  return cache.get(key)
}

/** Web App Manifest：让「添加到主屏幕」得到全屏、有图标、有名字的独立应用。 */
export const MANIFEST = {
  name: 'DSH Remote',
  short_name: 'DSH',
  description: '随时连回你电脑上的 DeepSeek Harness',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0f1115',
  theme_color: '#4d6bfe',
  icons: [
    { src: '/__pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/__pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/__pwa/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}
