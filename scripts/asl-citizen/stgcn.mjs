// Builds the ASL Citizen ST-GCN (OpenHands layout) as an ONNX graph from its PyTorch state_dict.
// Input  x      float32 [n, 2, 128, 27]  (channels = x/y, 128 frames, 27 keypoints)
// Output logits float32 [n, numClasses]
//
// Mirrors the reference module (inference mode, BatchNorm eps 1e-5):
//   data_bn over (v, c) channels -> 10 x { gcn 1x1 conv -> einsum with A*edge_importance -> BN -> ReLU ->
//   (9,1) temporal conv -> BN, + residual -> ReLU } -> mean over (T, V) -> Linear.
// BatchNorms that directly follow a conv are folded into that conv here (in float64).

import { FLOAT, GraphBuilder, INT64, encodeModel, float, ints } from './onnx.mjs'

export const FRAMES = 128
export const JOINTS = 27
export const CHANNELS = 2
const PARTITIONS = 3
const EPS = 1e-5
// (in channels, out channels, temporal stride, residual)
const BLOCKS = [
  [2, 64, 1, 'none'],
  [64, 64, 1, 'id'],
  [64, 64, 1, 'id'],
  [64, 64, 1, 'id'],
  [64, 128, 2, 'conv'],
  [128, 128, 1, 'id'],
  [128, 128, 1, 'id'],
  [128, 256, 2, 'conv'],
  [256, 256, 1, 'id'],
  [256, 256, 1, 'id'],
]

/** Check the state_dict matches the architecture exactly (like load_state_dict(strict=True)). */
function validate(sd) {
  const expected = new Map()
  const bn = (p, c) => {
    for (const s of ['weight', 'bias', 'running_mean', 'running_var']) expected.set(`${p}.${s}`, [c])
    expected.set(`${p}.num_batches_tracked`, [])
  }
  expected.set('encoder.A', [PARTITIONS, JOINTS, JOINTS])
  bn('encoder.data_bn', CHANNELS * JOINTS)
  BLOCKS.forEach(([cin, cout, , res], i) => {
    const p = `encoder.st_gcn_networks.${i}`
    expected.set(`${p}.gcn.conv.weight`, [cout * PARTITIONS, cin, 1, 1])
    expected.set(`${p}.gcn.conv.bias`, [cout * PARTITIONS])
    bn(`${p}.tcn.0`, cout)
    expected.set(`${p}.tcn.2.weight`, [cout, cout, 9, 1])
    expected.set(`${p}.tcn.2.bias`, [cout])
    bn(`${p}.tcn.3`, cout)
    if (res === 'conv') {
      expected.set(`${p}.residual.0.weight`, [cout, cin, 1, 1])
      expected.set(`${p}.residual.0.bias`, [cout])
      bn(`${p}.residual.1`, cout)
    }
    expected.set(`encoder.edge_importance.${i}`, [PARTITIONS, JOINTS, JOINTS])
  })
  const cls = sd.get('decoder.classifier.weight')
  const numClasses = cls?.shape?.[0]
  if (!numClasses) throw new Error('state_dict has no decoder.classifier.weight')
  expected.set('decoder.classifier.weight', [numClasses, 256])
  expected.set('decoder.classifier.bias', [numClasses])

  const missing = [...expected.keys()].filter((k) => !sd.has(k))
  const unexpected = [...sd.keys()].filter((k) => !expected.has(k))
  if (missing.length || unexpected.length) {
    throw new Error(`state_dict does not match the ST-GCN layout (missing: ${missing.slice(0, 5).join(', ') || 'none'}; unexpected: ${unexpected.slice(0, 5).join(', ') || 'none'})`)
  }
  for (const [k, shape] of expected) {
    if (JSON.stringify(sd.get(k).shape) !== JSON.stringify(shape)) {
      throw new Error(`state_dict ${k} has shape [${sd.get(k).shape}], expected [${shape}]`)
    }
  }
  return numClasses
}

/** BatchNorm (inference) as y = x * scale + shift, per channel, in float64. */
function bnAffine(sd, p) {
  const g = sd.get(`${p}.weight`).data
  const b = sd.get(`${p}.bias`).data
  const m = sd.get(`${p}.running_mean`).data
  const v = sd.get(`${p}.running_var`).data
  const scale = new Float64Array(g.length)
  const shift = new Float64Array(g.length)
  for (let c = 0; c < g.length; c++) {
    scale[c] = g[c] / Math.sqrt(v[c] + EPS)
    shift[c] = b[c] - m[c] * scale[c]
  }
  return { scale, shift }
}

/** Fold a following BatchNorm into conv weights [cout, ...] and bias [cout]. */
function foldConvBn(weight, bias, { scale, shift }) {
  const cout = scale.length
  const per = weight.length / cout
  const w = new Float32Array(weight.length)
  const b = new Float32Array(cout)
  for (let c = 0; c < cout; c++) {
    for (let j = 0; j < per; j++) w[c * per + j] = weight[c * per + j] * scale[c]
    b[c] = bias[c] * scale[c] + shift[c]
  }
  return { w, b }
}

/**
 * @param {Map<string, {shape: number[], data: Float32Array}>} sd  the checkpoint's state_dict
 * @returns {{ bytes: Buffer, numClasses: number }}  serialized ONNX model
 */
export function buildStgcnOnnx(sd, { docString = '' } = {}) {
  const numClasses = validate(sd)
  const W = (k) => sd.get(k).data
  const g = new GraphBuilder('aslcitizen_stgcn')
  const x = g.input('x', FLOAT, ['n', CHANNELS, FRAMES, JOINTS])

  // data_bn: BatchNorm1d over channel index v*C + c, applied as a [1, C, 1, V] scale + shift.
  const dbn = bnAffine(sd, 'encoder.data_bn')
  const dScale = new Float32Array(CHANNELS * JOINTS)
  const dShift = new Float32Array(CHANNELS * JOINTS)
  for (let c = 0; c < CHANNELS; c++) {
    for (let v = 0; v < JOINTS; v++) {
      dScale[c * JOINTS + v] = dbn.scale[v * CHANNELS + c]
      dShift[c * JOINTS + v] = dbn.shift[v * CHANNELS + c]
    }
  }
  const [xs] = g.node('Mul', [x, g.initializer('data_bn.scale', FLOAT, [1, CHANNELS, 1, JOINTS], dScale)], ['data_bn.mul'])
  let [h] = g.node('Add', [xs, g.initializer('data_bn.shift', FLOAT, [1, CHANNELS, 1, JOINTS], dShift)], ['data_bn.out'])

  const A = W('encoder.A')
  const sumAxis = g.initializer('axes_1', INT64, [1], [1])
  let t = FRAMES
  BLOCKS.forEach(([cin, cout, stride, res], i) => {
    const p = `encoder.st_gcn_networks.${i}`
    const name = (s) => `block${i}.${s}`

    // Spatial graph conv: 1x1 conv to K*cout channels, then sum_k sum_v y[n,k,c,t,v] * (A*imp)[k,v,w].
    const [y0] = g.node('Conv', [h, g.initializer(name('gcn.w'), FLOAT, [cout * PARTITIONS, cin, 1, 1], W(`${p}.gcn.conv.weight`)), g.initializer(name('gcn.b'), FLOAT, [cout * PARTITIONS], W(`${p}.gcn.conv.bias`))], [name('gcn.conv')], { kernel_shape: ints([1, 1]) })
    const [y1] = g.node('Reshape', [y0, g.initializer(name('shape_k'), INT64, [4], [0, PARTITIONS, cout * t, JOINTS])], [name('gcn.split')])
    const imp = W(`encoder.edge_importance.${i}`)
    const adj = new Float32Array(A.length)
    for (let j = 0; j < A.length; j++) adj[j] = A[j] * imp[j]
    const [y2] = g.node('MatMul', [y1, g.initializer(name('adj'), FLOAT, [PARTITIONS, JOINTS, JOINTS], adj)], [name('gcn.matmul')])
    const [y3] = g.node('ReduceSum', [y2, sumAxis], [name('gcn.sum')], { keepdims: 0 })
    const [y4] = g.node('Reshape', [y3, g.initializer(name('shape_c'), INT64, [4], [0, cout, t, JOINTS])], [name('gcn.out')])

    // Temporal conv: BN -> ReLU -> Conv(9,1) (+ folded BN).
    const [y5] = g.node('BatchNormalization', [
      y4,
      g.initializer(name('tcn.bn.scale'), FLOAT, [cout], W(`${p}.tcn.0.weight`)),
      g.initializer(name('tcn.bn.bias'), FLOAT, [cout], W(`${p}.tcn.0.bias`)),
      g.initializer(name('tcn.bn.mean'), FLOAT, [cout], W(`${p}.tcn.0.running_mean`)),
      g.initializer(name('tcn.bn.var'), FLOAT, [cout], W(`${p}.tcn.0.running_var`)),
    ], [name('tcn.bn')], { epsilon: float(EPS) })
    const [y6] = g.node('Relu', [y5], [name('tcn.relu')])
    const tc = foldConvBn(W(`${p}.tcn.2.weight`), W(`${p}.tcn.2.bias`), bnAffine(sd, `${p}.tcn.3`))
    let [y] = g.node('Conv', [y6, g.initializer(name('tcn.w'), FLOAT, [cout, cout, 9, 1], tc.w), g.initializer(name('tcn.b'), FLOAT, [cout], tc.b)], [name('tcn.conv')], {
      kernel_shape: ints([9, 1]),
      strides: ints([stride, 1]),
      pads: ints([4, 0, 4, 0]),
    })

    if (res === 'id') {
      ;[y] = g.node('Add', [y, h], [name('add')])
    } else if (res === 'conv') {
      const rc = foldConvBn(W(`${p}.residual.0.weight`), W(`${p}.residual.0.bias`), bnAffine(sd, `${p}.residual.1`))
      const [r] = g.node('Conv', [h, g.initializer(name('res.w'), FLOAT, [cout, cin, 1, 1], rc.w), g.initializer(name('res.b'), FLOAT, [cout], rc.b)], [name('res.conv')], {
        kernel_shape: ints([1, 1]),
        strides: ints([stride, 1]),
      })
      ;[y] = g.node('Add', [y, r], [name('add')])
    }
    ;[h] = g.node('Relu', [y], [name('out')])
    t = Math.floor((t - 1) / stride) + 1
  })

  // Head: mean over (T, V), then the linear classifier.
  const [pooled] = g.node('GlobalAveragePool', [h], ['pool'])
  const [flat] = g.node('Flatten', [pooled], ['features'], { axis: 1 })
  g.node('Gemm', [
    flat,
    g.initializer('classifier.w', FLOAT, [numClasses, 256], W('decoder.classifier.weight')),
    g.initializer('classifier.b', FLOAT, [numClasses], W('decoder.classifier.bias')),
  ], ['logits'], { transB: 1 }, { exactOutputs: true })
  g.output('logits', FLOAT, ['n', numClasses])

  return { bytes: encodeModel(g, { producerName: 'fastASL', docString }), numClasses }
}
