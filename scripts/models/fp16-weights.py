"""Store an ONNX model's large float32 initializers as float16, each followed by a Cast back to
float32, so the graph still computes in fp32 (onnxruntime folds the casts when it loads).

Used once on the Kaggle sign model (src/renderer/public/models/islr1st.onnx): all 5,490,414 of
its weights are exactly representable in float16 (the TFLite original stored them that way), so
the file halved (22.2 -> 11.2 MB) with bit-identical outputs.

usage: uv run --python 3.12 --with onnx==1.22.0 python scripts/models/fp16-weights.py IN.onnx OUT.onnx
"""
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto
src, dst = sys.argv[1:3]
m = onnx.load(src)
g = m.graph
new_inits, casts, n = [], [], 0
for init in g.initializer:
    if init.data_type == TensorProto.FLOAT and np.prod(init.dims) >= 64:
        arr = numpy_helper.to_array(init)
        h = numpy_helper.from_array(arr.astype(np.float16), init.name + '__fp16')
        new_inits.append(h)
        casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + '__cast'))
        n += 1
    else:
        new_inits.append(init)
del g.initializer[:]
g.initializer.extend(new_inits)
nodes = list(g.node)
del g.node[:]
g.node.extend(casts + nodes)
onnx.checker.check_model(m)
onnx.save(m, dst)
print('converted', n, 'initializers')
