// Minimal, safe loader for a PyTorch zip checkpoint holding a state_dict:
//   <prefix>/data.pkl       pickle (protocol 2) describing an OrderedDict of tensors
//   <prefix>/data/<key>     raw little-endian storage bytes, one file per storage
// Only a whitelist of globals is resolvable (no arbitrary code, unlike Python's pickle), so a
// tampered file can at worst fail to load. Returns Map<name, { dtype, shape, data: Float32Array }>.

import { bufferSource, openZip, readEntry } from './zip.mjs'

const STORAGE_TYPES = {
  FloatStorage: { dtype: 'float32', bytes: 4, get: (dv, o) => dv.getFloat32(o, true) },
  DoubleStorage: { dtype: 'float64', bytes: 8, get: (dv, o) => dv.getFloat64(o, true) },
  HalfStorage: { dtype: 'float16', bytes: 2, get: (dv, o) => halfToFloat(dv.getUint16(o, true)) },
  BFloat16Storage: { dtype: 'bfloat16', bytes: 2, get: (dv, o) => bf16ToFloat(dv.getUint16(o, true)) },
  LongStorage: { dtype: 'int64', bytes: 8, get: (dv, o) => Number(dv.getBigInt64(o, true)) },
  IntStorage: { dtype: 'int32', bytes: 4, get: (dv, o) => dv.getInt32(o, true) },
  ShortStorage: { dtype: 'int16', bytes: 2, get: (dv, o) => dv.getInt16(o, true) },
  CharStorage: { dtype: 'int8', bytes: 1, get: (dv, o) => dv.getInt8(o) },
  ByteStorage: { dtype: 'uint8', bytes: 1, get: (dv, o) => dv.getUint8(o) },
  BoolStorage: { dtype: 'bool', bytes: 1, get: (dv, o) => dv.getUint8(o) },
}

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)
function bf16ToFloat(h) {
  u32[0] = h << 16
  return f32[0]
}
function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  if (e === 31) return m ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + m / 1024)
}

class Mark {}
const MARK = new Mark()

/**
 * Unpickle `bytes`. `globals` maps "module name" to a value; `persistentLoad(pid)` resolves BINPERSID.
 * Tuples and lists are JS arrays, dicts are Maps, callables are JS functions (invoked by REDUCE).
 */
export function unpickle(bytes, { globals, persistentLoad }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const stack = []
  const marks = []
  const memo = new Map()
  let p = 0

  const top = () => stack[stack.length - 1]
  const popMark = () => {
    if (!marks.length) throw new Error('pickle: MARK expected')
    return stack.splice(marks.pop())
  }
  const readLine = () => {
    const end = buf.indexOf(0x0a, p)
    if (end < 0) throw new Error('pickle: unterminated line')
    const s = buf.toString('utf8', p, end)
    p = end + 1
    return s
  }
  const resolve = (module, name) => {
    const key = `${module} ${name}`
    if (!Object.hasOwn(globals, key)) throw new Error(`pickle: refusing unsupported global ${module}.${name}`)
    return globals[key]
  }
  const call = (fn, args) => {
    if (typeof fn !== 'function') throw new Error('pickle: REDUCE on a non-callable')
    return fn(...args)
  }

  while (p < buf.length) {
    const op = buf[p++]
    switch (op) {
      case 0x80: // PROTO
        p += 1
        break
      case 0x95: // FRAME (8-byte length; frames are just a read-ahead hint)
        p += 8
        break
      case 0x63: { // GLOBAL 'c'
        const module = readLine()
        const name = readLine()
        stack.push(resolve(module, name))
        break
      }
      case 0x93: { // STACK_GLOBAL
        const name = stack.pop()
        const module = stack.pop()
        stack.push(resolve(module, name))
        break
      }
      case 0x71: // BINPUT 'q'
        memo.set(buf[p++], top())
        break
      case 0x72: // LONG_BINPUT 'r'
        memo.set(buf.readUInt32LE(p), top())
        p += 4
        break
      case 0x94: // MEMOIZE
        memo.set(memo.size, top())
        break
      case 0x68: // BINGET 'h'
        stack.push(memo.get(buf[p++]))
        break
      case 0x6a: // LONG_BINGET 'j'
        stack.push(memo.get(buf.readUInt32LE(p)))
        p += 4
        break
      case 0x29: // EMPTY_TUPLE ')'
        stack.push([])
        break
      case 0x7d: // EMPTY_DICT '}'
        stack.push(new Map())
        break
      case 0x5d: // EMPTY_LIST ']'
        stack.push([])
        break
      case 0x28: // MARK '('
        marks.push(stack.length)
        break
      case 0x74: // TUPLE 't'
        stack.push(popMark())
        break
      case 0x85: // TUPLE1
        stack.push([stack.pop()])
        break
      case 0x86: { // TUPLE2
        const b = stack.pop()
        stack.push([stack.pop(), b])
        break
      }
      case 0x87: { // TUPLE3
        const c = stack.pop()
        const b = stack.pop()
        stack.push([stack.pop(), b, c])
        break
      }
      case 0x58: { // BINUNICODE 'X'
        const n = buf.readUInt32LE(p)
        p += 4
        stack.push(buf.toString('utf8', p, p + n))
        p += n
        break
      }
      case 0x8c: { // SHORT_BINUNICODE
        const n = buf[p++]
        stack.push(buf.toString('utf8', p, p + n))
        p += n
        break
      }
      case 0x4a: // BININT 'J'
        stack.push(buf.readInt32LE(p))
        p += 4
        break
      case 0x4b: // BININT1 'K'
        stack.push(buf[p++])
        break
      case 0x4d: // BININT2 'M'
        stack.push(buf.readUInt16LE(p))
        p += 2
        break
      case 0x8a: { // LONG1
        const n = buf[p++]
        let v = 0n
        for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[p + i])
        if (n && buf[p + n - 1] & 0x80) v -= 1n << BigInt(8 * n)
        p += n
        stack.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v)
        break
      }
      case 0x47: // BINFLOAT 'G' (big-endian double)
        stack.push(buf.readDoubleBE(p))
        p += 8
        break
      case 0x88: // NEWTRUE
        stack.push(true)
        break
      case 0x89: // NEWFALSE
        stack.push(false)
        break
      case 0x4e: // NONE 'N'
        stack.push(null)
        break
      case 0x52: { // REDUCE 'R'
        const args = stack.pop()
        const fn = stack.pop()
        stack.push(call(fn, args))
        break
      }
      case 0x51: // BINPERSID 'Q'
        stack.push(persistentLoad(stack.pop()))
        break
      case 0x73: { // SETITEM 's'
        const value = stack.pop()
        const key = stack.pop()
        setItem(top(), key, value)
        break
      }
      case 0x75: { // SETITEMS 'u'
        const items = popMark()
        const dict = top()
        for (let i = 0; i < items.length; i += 2) setItem(dict, items[i], items[i + 1])
        break
      }
      case 0x61: { // APPEND 'a'
        const value = stack.pop()
        top().push(value)
        break
      }
      case 0x65: { // APPENDS 'e'
        const items = popMark()
        top().push(...items)
        break
      }
      case 0x62: { // BUILD 'b' — e.g. OrderedDict._metadata; kept but unused
        const state = stack.pop()
        const inst = top()
        if (inst && typeof inst === 'object') inst.pickleState = state
        break
      }
      case 0x2e: // STOP '.'
        if (stack.length !== 1) throw new Error(`pickle: STOP with ${stack.length} items on the stack`)
        return stack.pop()
      default:
        throw new Error(`pickle: unsupported opcode 0x${op.toString(16)} at byte ${p - 1}`)
    }
  }
  throw new Error('pickle: missing STOP')
}

function setItem(dict, key, value) {
  if (!(dict instanceof Map)) throw new Error('pickle: SETITEM on a non-dict')
  dict.set(key, value)
}

function contiguousStrides(shape) {
  const s = new Array(shape.length)
  let acc = 1
  for (let i = shape.length - 1; i >= 0; i--) {
    s[i] = acc
    acc *= shape[i]
  }
  return s
}

/** torch._utils._rebuild_tensor_v2(storage, storage_offset, size, stride, requires_grad, backward_hooks[, metadata]) */
function rebuildTensor(storage, offset, size, stride) {
  if (!storage || !storage.type) throw new Error('pickle: _rebuild_tensor_v2 without a storage')
  const shape = size.map(Number)
  const strides = stride.map(Number)
  const numel = shape.reduce((a, b) => a * b, 1)
  const { type, bytes } = storage
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(numel)
  const want = contiguousStrides(shape)
  const contiguous = shape.every((d, i) => d === 1 || strides[i] === want[i])
  if (numel && (offset + (contiguous ? numel : 1)) * type.bytes > bytes.byteLength) {
    throw new Error('pickle: tensor runs past the end of its storage')
  }
  if (contiguous) {
    for (let i = 0; i < numel; i++) out[i] = type.get(dv, (offset + i) * type.bytes)
  } else {
    // Gather a strided view element by element (row-major order).
    const idx = new Array(shape.length).fill(0)
    for (let i = 0; i < numel; i++) {
      let src = offset
      for (let d = 0; d < shape.length; d++) src += idx[d] * strides[d]
      if ((src + 1) * type.bytes > bytes.byteLength) throw new Error('pickle: strided tensor runs past its storage')
      out[i] = type.get(dv, src * type.bytes)
      for (let d = shape.length - 1; d >= 0; d--) {
        if (++idx[d] < shape[d]) break
        idx[d] = 0
      }
    }
  }
  return { dtype: type.dtype, shape, data: out }
}

/**
 * Load a PyTorch zip checkpoint (Buffer) whose pickle is a flat state_dict of tensors.
 * @returns {Promise<Map<string, {dtype: string, shape: number[], data: Float32Array}>>}
 */
export async function loadStateDict(checkpoint) {
  const zip = await openZip(bufferSource(checkpoint, 'checkpoint'))
  const pklName = [...zip.entries.keys()].find((n) => n === 'data.pkl' || n.endsWith('/data.pkl'))
  if (!pklName) throw new Error('checkpoint: no data.pkl inside (not a PyTorch zip checkpoint?)')
  const prefix = pklName.slice(0, -'data.pkl'.length)
  const byteorder = zip.entries.get(`${prefix}byteorder`)
  if (byteorder && (await readEntry(zip, byteorder)).toString().trim() !== 'little') {
    throw new Error('checkpoint: big-endian storages are not supported')
  }

  const globals = {
    'collections OrderedDict': () => new Map(),
    'torch._utils _rebuild_tensor_v2': rebuildTensor,
  }
  for (const [name, type] of Object.entries(STORAGE_TYPES)) globals[`torch ${name}`] = { storageType: name, ...type }

  // Read every storage file up front (they are stored, not compressed) so unpickling stays synchronous.
  const raw = new Map()
  for (const [name, entry] of zip.entries) {
    if (name.startsWith(`${prefix}data/`)) raw.set(name.slice(prefix.length + 5), await readEntry(zip, entry))
  }
  const storages = new Map() // key -> { type, bytes }, shared between tensors that view the same storage
  const persistentLoad = (pid) => {
    if (!Array.isArray(pid) || pid[0] !== 'storage') throw new Error(`checkpoint: unsupported persistent id ${JSON.stringify(pid)}`)
    const [, type, key, , numel] = pid
    if (!type?.storageType) throw new Error('checkpoint: unknown storage type')
    if (!storages.has(key)) {
      const bytes = raw.get(String(key))
      if (!bytes) throw new Error(`checkpoint: missing storage data/${key}`)
      if (bytes.length < numel * type.bytes) throw new Error(`checkpoint: storage ${key} is truncated`)
      storages.set(key, { type, bytes })
    }
    return storages.get(key)
  }

  const root = unpickle(await readEntry(zip, pklName), { globals, persistentLoad })
  if (!(root instanceof Map)) throw new Error('checkpoint: top-level object is not a state_dict (OrderedDict)')
  const out = new Map()
  for (const [name, value] of root) {
    if (!value || !(value.data instanceof Float32Array)) throw new Error(`checkpoint: ${name} is not a tensor`)
    out.set(name, value)
  }
  return out
}
