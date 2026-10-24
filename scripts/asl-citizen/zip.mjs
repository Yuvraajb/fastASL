// Minimal read-only ZIP reader (stored + deflate, ZIP64 aware) over a byte "source":
//   bufferSource(buf)          a ZIP already in memory
//   httpSource(url, opts)      a remote ZIP read with HTTP Range requests, so only the bytes we ask for
//                              (end records, central directory, one member) ever leave the server.
// openZip(source) parses the end-of-central-directory records and the central directory;
// findEntry(source, match) does the same but stops reading the directory at the first matching entry;
// readEntry(zip, entry) fetches that one member's local header + data and returns its bytes (CRC-checked).

import { crc32 as zlibCrc32, inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_SIZE = 22
const ZIP64_LOCATOR_SIZE = 20
const MAX_COMMENT = 0xffff
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

// ---------------------------------------------------------------- sources

export function bufferSource(buf, label = 'buffer') {
  return {
    label,
    size: buf.length,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > buf.length) {
        throw new Error(`${label}: read ${offset}+${length} is outside the file (${buf.length} bytes)`)
      }
      return buf.subarray(offset, offset + length)
    },
  }
}

/**
 * Remote ZIP over HTTP Range requests. `maxBytes` is a hard cap on the total bytes this source may
 * download (checked before each request), `onBytes(n, what)` is called after each successful range.
 */
export async function httpSource(url, { timeoutMs = 120_000, maxBytes = Infinity, onBytes = () => {}, label = url } = {}) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!head.ok) throw new Error(`${label}: HEAD failed: HTTP ${head.status} ${head.statusText}`)
  const size = Number(head.headers.get('content-length'))
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${label}: server did not report a usable Content-Length`)
  const finalUrl = head.url || url
  let downloaded = 0

  return {
    label,
    size,
    get downloaded() {
      return downloaded
    },
    async read(offset, length, what = 'range') {
      if (length === 0) return Buffer.alloc(0)
      if (offset < 0 || length < 0 || offset + length > size) {
        throw new Error(`${label}: range ${offset}+${length} is outside the file (${size} bytes)`)
      }
      if (downloaded + length > maxBytes) {
        throw new Error(`${label}: refusing to download ${length} more bytes (${what}); cap is ${maxBytes} bytes in total`)
      }
      const end = offset + length - 1
      let lastErr
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(finalUrl, {
            headers: { Range: `bytes=${offset}-${end}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (res.status !== 206) {
            // A 200 here would be the WHOLE file: never read its body.
            await res.body?.cancel().catch(() => {})
            throw new Error(`${label}: server ignored the Range request (HTTP ${res.status}); refusing to download the whole file`)
          }
          const cr = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '')
          if (!cr || Number(cr[1]) !== offset || Number(cr[2]) !== end) {
            await res.body?.cancel().catch(() => {})
            throw new Error(`${label}: unexpected Content-Range "${res.headers.get('content-range')}" for bytes ${offset}-${end}`)
          }
          const bytes = Buffer.from(await res.arrayBuffer())
          if (bytes.length !== length) throw new Error(`${label}: short range read (${bytes.length} of ${length} bytes)`)
          downloaded += length
          onBytes(length, what)
          return bytes
        } catch (err) {
          lastErr = err
          if (/refusing|Content-Range/.test(String(err?.message))) break // not transient
          if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
      throw lastErr
    },
  }
}

// ---------------------------------------------------------------- archive

const u64 = (buf, off) => {
  const v = buf.readBigUInt64LE(off)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP64 value too large')
  return Number(v)
}

/** Locate and parse the end records (EOCD, ZIP64 locator + record). */
async function readEnd(source) {
  // Most archives have no comment: try a small tail first, then the maximum comment length.
  for (const want of [1024, EOCD_SIZE + MAX_COMMENT + ZIP64_LOCATOR_SIZE]) {
    const len = Math.min(source.size, want)
    const tailStart = source.size - len
    const tail = await source.read(tailStart, len, 'end of central directory')
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue
      const commentLen = tail.readUInt16LE(i + 20)
      if (i + EOCD_SIZE + commentLen !== tail.length) continue // a stray signature inside the comment
      const eocdOffset = tailStart + i
      let count = tail.readUInt16LE(i + 10)
      let cdSize = tail.readUInt32LE(i + 12)
      let cdOffset = tail.readUInt32LE(i + 16)
      let zip64 = false
      // ZIP64: a locator sits immediately before the EOCD.
      if (eocdOffset >= ZIP64_LOCATOR_SIZE) {
        let loc
        const li = i - ZIP64_LOCATOR_SIZE
        if (li >= 0) loc = tail.subarray(li, li + ZIP64_LOCATOR_SIZE)
        else loc = await source.read(eocdOffset - ZIP64_LOCATOR_SIZE, ZIP64_LOCATOR_SIZE, 'ZIP64 locator')
        if (loc.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
          const recOffset = u64(loc, 8)
          const rec = recOffset >= tailStart && recOffset + 56 <= source.size && recOffset + 56 <= tailStart + tail.length
            ? tail.subarray(recOffset - tailStart, recOffset - tailStart + 56)
            : await source.read(recOffset, 56, 'ZIP64 end record')
          if (rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error(`${source.label}: bad ZIP64 end record`)
          count = u64(rec, 32)
          cdSize = u64(rec, 40)
          cdOffset = u64(rec, 48)
          zip64 = true
        }
      }
      if (!zip64 && (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX)) {
        throw new Error(`${source.label}: ZIP64 archive without a ZIP64 locator`)
      }
      if (cdOffset + cdSize > source.size) throw new Error(`${source.label}: central directory is outside the file`)
      return { count, cdSize, cdOffset, zip64 }
    }
    if (len === source.size) break
  }
  throw new Error(`${source.label}: not a ZIP file (no end-of-central-directory record)`)
}

/** Parse one central directory record at `p`; returns { entry, next } or null if `cd` ends mid-record. */
function parseRecord(cd, p, label) {
  if (p + 46 > cd.length) return null
  if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`${label}: corrupt central directory`)
  const nameLen = cd.readUInt16LE(p + 28)
  const extraLen = cd.readUInt16LE(p + 30)
  const commentLen = cd.readUInt16LE(p + 32)
  const next = p + 46 + nameLen + extraLen + commentLen
  if (next > cd.length) return null
  const flags = cd.readUInt16LE(p + 8)
  const method = cd.readUInt16LE(p + 10)
  const crc = cd.readUInt32LE(p + 16)
  let compressedSize = cd.readUInt32LE(p + 20)
  let size = cd.readUInt32LE(p + 24)
  let localOffset = cd.readUInt32LE(p + 42)
  const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
  // ZIP64 extended information (0x0001): only the fields that overflowed are present, in this order.
  let e = p + 46 + nameLen
  const extraEnd = e + extraLen
  while (e + 4 <= extraEnd) {
    const id = cd.readUInt16LE(e)
    const len = cd.readUInt16LE(e + 2)
    if (id === 0x0001) {
      let q = e + 4
      if (size === U32_MAX) (size = u64(cd, q)), (q += 8)
      if (compressedSize === U32_MAX) (compressedSize = u64(cd, q)), (q += 8)
      if (localOffset === U32_MAX) (localOffset = u64(cd, q)), (q += 8)
    }
    e += 4 + len
  }
  return { entry: { name, flags, method, crc, compressedSize, size, localOffset }, next }
}

/** Read the end records + the whole central directory. */
export async function openZip(source) {
  const end = await readEnd(source)
  const cd = await source.read(end.cdOffset, end.cdSize, 'central directory')
  const entries = new Map()
  let p = 0
  for (let n = 0; n < end.count; n++) {
    const rec = parseRecord(cd, p, source.label)
    if (!rec) throw new Error(`${source.label}: central directory is truncated`)
    entries.set(rec.entry.name, rec.entry)
    p = rec.next
  }
  return { source, ...end, entries }
}

/**
 * Find one member without fetching the whole central directory: read the end records, then scan the
 * directory in growing chunks (64 KiB, doubling up to 4 MiB) and stop at the first entry `match`es.
 * `onEnd(end)` runs once the end records are known (e.g. to report sizes). Returns { zip, entry|null }.
 */
export async function findEntry(source, match, { onEnd = () => {}, chunkSize = 64 * 1024 } = {}) {
  const end = await readEnd(source)
  onEnd(end)
  const zip = { source, ...end, entries: new Map() }
  const stop = end.cdOffset + end.cdSize
  let pos = end.cdOffset
  let pending = Buffer.alloc(0)
  let seen = 0
  while (seen < end.count) {
    let p = 0
    for (let rec; seen < end.count && (rec = parseRecord(pending, p, source.label)); seen++) {
      zip.entries.set(rec.entry.name, rec.entry)
      p = rec.next
      if (match(rec.entry)) return { zip, entry: rec.entry }
    }
    pending = pending.subarray(p)
    if (seen === end.count) break
    if (pos >= stop) throw new Error(`${source.label}: central directory is truncated`)
    const len = Math.min(chunkSize, stop - pos)
    const chunk = await source.read(pos, len, 'central directory')
    pos += len
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    chunkSize = Math.min(chunkSize * 2, 4 << 20)
  }
  return { zip, entry: null }
}

let crcTable
function crc32(buf) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buf) >>> 0
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Byte offset of a member's data (after its local header). */
export async function dataOffset(zip, entry) {
  const lh = await zip.source.read(entry.localOffset, 30, `local header of ${entry.name}`)
  if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`${zip.source.label}: bad local header for ${entry.name}`)
  return entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
}

/** Fetch, decompress and CRC-check one member. */
export async function readEntry(zip, name) {
  const entry = typeof name === 'string' ? zip.entries.get(name) : name
  if (!entry) throw new Error(`${zip.source.label}: no member named ${name}`)
  if (entry.flags & 0x1) throw new Error(`${zip.source.label}: ${entry.name} is encrypted`)
  const start = await dataOffset(zip, entry)
  const raw = await zip.source.read(start, entry.compressedSize, entry.name)
  let out
  if (entry.method === 0) out = raw
  else if (entry.method === 8) out = inflateRawSync(raw)
  else throw new Error(`${zip.source.label}: ${entry.name} uses unsupported compression method ${entry.method}`)
  if (out.length !== entry.size) throw new Error(`${zip.source.label}: ${entry.name} inflated to ${out.length} bytes, expected ${entry.size}`)
  if (crc32(out) !== entry.crc) throw new Error(`${zip.source.label}: ${entry.name} failed its CRC check (corrupt download?)`)
  return out
}
