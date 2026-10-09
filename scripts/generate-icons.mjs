// Generates resources/icon.png (512px) and resources/icon.ico (16–256px) without native deps.
// The mark: a rounded square with an indigo→teal gradient and a white speech-bubble ring.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources')
mkdirSync(out, { recursive: true })

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x) - half + r
  const qy = Math.abs(y) - half + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

function render(size) {
  const ss = 4
  const buf = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size - 0.5
          const y = (py + (sy + 0.5) / ss) / size - 0.5
          if (sdRoundRect(x, y, 0.47, 0.13) > 0) continue
          const t = Math.min(1, Math.max(0, (x + y + 1) / 2))
          let cr = 99 + (45 - 99) * t, cg = 102 + (212 - 102) * t, cb = 241 + (191 - 241) * t
          // Speech-bubble ring with a tail at the lower left, plus a centre dot.
          const d = Math.hypot(x, y + 0.02)
          const ring = Math.abs(d - 0.24) < 0.055
          const tail = x < -0.08 && x > -0.27 && y > 0.12 && y < 0.33 && y - 0.12 > -(x + 0.08) * 1.1 && Math.abs(d - 0.24) < 0.16 && d > 0.2
          const dot = Math.hypot(x, y + 0.02) < 0.075
          if (ring || tail || dot) { cr = 255; cg = 255; cb = 255 }
          r += cr; g += cg; b += cb; a += 255
        }
      }
      const n = ss * ss
      const i = (py * size + px) * 4
      const cov = a / n
      buf[i] = cov ? r / (a / 255) : 0
      buf[i + 1] = cov ? g / (a / 255) : 0
      buf[i + 2] = cov ? b / (a / 255) : 0
      buf[i + 3] = cov
    }
  }
  return buf
}

const big = png(512, render(512))
writeFileSync(join(out, 'icon.png'), big)

const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map((s) => png(s, render(s)))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
const dir = Buffer.alloc(16 * images.length)
let offset = 6 + dir.length
images.forEach((img, i) => {
  const s = sizes[i]
  dir[i * 16] = s >= 256 ? 0 : s
  dir[i * 16 + 1] = s >= 256 ? 0 : s
  dir.writeUInt16LE(1, i * 16 + 4)
  dir.writeUInt16LE(32, i * 16 + 6)
  dir.writeUInt32LE(img.length, i * 16 + 8)
  dir.writeUInt32LE(offset, i * 16 + 12)
  offset += img.length
})
writeFileSync(join(out, 'icon.ico'), Buffer.concat([header, dir, ...images]))
console.log('icons written to', out)
