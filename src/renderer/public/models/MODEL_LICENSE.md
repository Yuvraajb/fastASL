# Pretrained sign models

## islr1st.onnx — Kaggle "asl-signs" 1st-place model (MIT)

- **What:** the winning model of Google's Isolated Sign Language Recognition competition on Kaggle
  (https://www.kaggle.com/competitions/asl-signs), by hoyso48. 250 signs, MediaPipe landmarks in.
- **Source of these weights:** https://huggingface.co/sign/kaggle-asl-signs-1st-place
  (revision d831c2f58cefbc5110dfbb91cc8e6eb516b4ccfc): `model.tflite` and
  `sign_to_prediction_index_map.json` (copied to `src/renderer/src/engine/model/islrLabels.json`).
- **Original solution:** https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution
  and https://www.kaggle.com/code/hoyso48/1st-place-solution-inference.
- **Licence:** MIT, as declared by the Hugging Face model card (`license: mit`). The original
  GitHub repository has no licence file of its own.
- **Conversion:** `model.tflite` was converted to ONNX (opset 17) with tf2onnx 1.17.0; its
  outputs match the TFLite model's. Its weights are then stored as float16 with a Cast back to
  float32 (`scripts/models/fp16-weights.py`): every weight is exactly representable in float16,
  so the outputs are bit-identical and the file is 11.2 MB instead of 22.2 MB. Input `[T, 543, 3]`
  float32 (MediaPipe face, left hand, pose, right hand; NaN when missing), output 250 logits.

```
MIT License

Copyright (c) the authors of the Kaggle asl-signs 1st-place solution

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## asl-citizen/ — ASL Citizen ST-GCN (NOT in this repository)

Microsoft's ASL Citizen ST-GCN (2731 signs) is released under the Microsoft Research licence for
the ASL Citizen dataset: non-commercial research use only, no redistribution. It is never
committed. `npm run setup:citizen` downloads the official weights
(https://github.com/microsoft/ASL-citizen-code/releases/tag/checkpoints_v1) and the dataset's
`train.csv` word list, and converts them to `asl-citizen/` on your own machine (gitignored).
Builds made from this folder include it, so don't distribute a build that has it.
