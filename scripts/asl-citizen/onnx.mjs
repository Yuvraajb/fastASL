// Minimal protobuf encoder for an ONNX ModelProto (just the fields a plain inference graph needs).
// Field numbers follow onnx/onnx.proto (proto2): repeated scalars are written unpacked.
//
//   const g = new GraphBuilder('name')
//   g.input('x', FLOAT, ['n', 2, 128, 27]); g.initializer('w', FLOAT, [4, 2], float32Array)
//   g.node('Conv', ['x', 'w'], ['y'], { kernel_shape: ints([1, 1]) }); g.output('y', FLOAT, ['n', 4])
//   const bytes = encodeModel(g, { producerName: 'fastASL' })

export const FLOAT = 1
export const INT64 = 7

const IR_VERSION = 8
const OPSET = 17

// ---------------------------------------------------------------- wire format

const WIRE_VARINT = 0
const WIRE_I32 = 5
const WIRE_LEN = 2

function varint(value) {
  let v = BigInt.asUintN(64, BigInt(value)) // negatives become 10-byte two's complement, as protobuf requires
  const out = []
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}

const tag = (field, wire) => varint((field << 3) | wire)

/** A message is built as a list of Buffers, concatenated once at the end of each level. */
class Msg {
  parts = []
  int(field, value) {
    this.parts.push(tag(field, WIRE_VARINT), varint(value))
    return this
  }
  ints(field, values) {
    for (const v of values) this.int(field, v)
    return this
  }
  float(field, value) {
    const b = Buffer.alloc(4)
    b.writeFloatLE(value)
    this.parts.push(tag(field, WIRE_I32), b)
    return this
  }
  bytes(field, buf) {
    this.parts.push(tag(field, WIRE_LEN), varint(buf.length), buf)
    return this
  }
  string(field, s) {
    return this.bytes(field, Buffer.from(s, 'utf8'))
  }
  strings(field, list) {
    for (const s of list) this.string(field, s)
    return this
  }
  msg(field, m) {
    return this.bytes(field, m.finish())
  }
  finish() {
    return Buffer.concat(this.parts)
  }
}

// ---------------------------------------------------------------- ONNX messages

// AttributeProto.AttributeType
const ATTR_FLOAT = 1
const ATTR_INT = 2
const ATTR_INTS = 7

/** Attribute value helpers: plain numbers are INT, use float()/ints() for the others. */
export const float = (v) => ({ type: ATTR_FLOAT, v })
export const int = (v) => ({ type: ATTR_INT, v })
export const ints = (v) => ({ type: ATTR_INTS, v })

function attribute(name, value) {
  const a = typeof value === 'number' ? int(value) : value
  const m = new Msg().string(1, name) // name = 1
  if (a.type === ATTR_FLOAT) m.float(2, a.v) // f = 2
  else if (a.type === ATTR_INT) m.int(3, a.v) // i = 3
  else if (a.type === ATTR_INTS) m.ints(8, a.v) // ints = 8
  else throw new Error(`onnx: unsupported attribute type for ${name}`)
  return m.int(20, a.type) // type = 20
}

function tensor(name, dataType, dims, data) {
  let raw
  if (dataType === FLOAT) {
    const f = data instanceof Float32Array ? data : Float32Array.from(data)
    raw = Buffer.alloc(f.length * 4)
    for (let i = 0; i < f.length; i++) raw.writeFloatLE(f[i], i * 4)
  } else if (dataType === INT64) {
    raw = Buffer.alloc(data.length * 8)
    for (let i = 0; i < data.length; i++) raw.writeBigInt64LE(BigInt(data[i]), i * 8)
  } else {
    throw new Error(`onnx: unsupported tensor data type ${dataType}`)
  }
  const count = dims.reduce((a, b) => a * b, 1)
  if (count !== data.length) throw new Error(`onnx: initializer ${name} has ${data.length} values for dims [${dims}]`)
  return new Msg()
    .ints(1, dims) // dims = 1
    .int(2, dataType) // data_type = 2
    .string(8, name) // name = 8
    .bytes(9, raw) // raw_data = 9
}

function valueInfo(name, elemType, shape) {
  const dims = new Msg()
  for (const d of shape) {
    const dim = new Msg()
    if (typeof d === 'string') dim.string(2, d) // dim_param = 2
    else dim.int(1, d) // dim_value = 1
    dims.msg(1, dim) // TensorShapeProto.dim = 1
  }
  const tensorType = new Msg().int(1, elemType).msg(2, dims) // elem_type = 1, shape = 2
  const type = new Msg().msg(1, tensorType) // TypeProto.tensor_type = 1
  return new Msg().string(1, name).msg(2, type) // ValueInfoProto: name = 1, type = 2
}

export class GraphBuilder {
  constructor(name) {
    this.name = name
    this.nodes = []
    this.initializers = []
    this.inputs = []
    this.outputs = []
    this.names = new Set()
    this.counter = 0
  }

  /** A fresh, unique tensor/node name. */
  fresh(hint) {
    let n = hint
    while (this.names.has(n)) n = `${hint}_${++this.counter}`
    this.names.add(n)
    return n
  }

  input(name, elemType, shape) {
    this.names.add(name)
    this.inputs.push(valueInfo(name, elemType, shape))
    return name
  }

  output(name, elemType, shape) {
    this.outputs.push(valueInfo(name, elemType, shape))
    return name
  }

  /** Add a constant; returns its (unique) name. */
  initializer(hint, dataType, dims, data) {
    const name = this.fresh(hint)
    this.initializers.push(tensor(name, dataType, dims, data))
    return name
  }

  /** Add a node; `outputs` are name hints (made unique) unless `exactOutputs` is set. Returns output names. */
  node(opType, inputs, outputs, attrs = {}, { exactOutputs = false } = {}) {
    const outs = outputs.map((o) => (exactOutputs ? (this.names.add(o), o) : this.fresh(o)))
    const m = new Msg()
      .strings(1, inputs) // input = 1
      .strings(2, outs) // output = 2
      .string(3, this.fresh(`${opType}_${this.nodes.length}`)) // name = 3
      .string(4, opType) // op_type = 4
    for (const [k, v] of Object.entries(attrs)) m.msg(5, attribute(k, v)) // attribute = 5
    this.nodes.push(m)
    return outs
  }

  encode() {
    const g = new Msg()
    for (const n of this.nodes) g.msg(1, n) // node = 1
    g.string(2, this.name) // name = 2
    for (const t of this.initializers) g.msg(5, t) // initializer = 5
    for (const i of this.inputs) g.msg(11, i) // input = 11
    for (const o of this.outputs) g.msg(12, o) // output = 12
    return g
  }
}

/** Serialize a ModelProto around the graph. */
export function encodeModel(graph, { producerName = 'fastASL', producerVersion = '1', docString = '' } = {}) {
  const opset = new Msg().string(1, '').int(2, OPSET) // OperatorSetIdProto: domain = 1, version = 2
  const m = new Msg()
    .int(1, IR_VERSION) // ir_version = 1
    .string(2, producerName) // producer_name = 2
    .string(3, producerVersion) // producer_version = 3
  if (docString) m.string(6, docString) // doc_string = 6
  m.msg(7, graph.encode()) // graph = 7
  m.msg(8, opset) // opset_import = 8
  return m.finish()
}
