#!/usr/bin/env python3
"""
Turns ASL Citizen videos into the app's FrameSample[] JSON, using the same MediaPipe models the app ships
(hand_landmarker.task, face_detector.tflite), so recognition is replayed on real signers.

License: ASL Citizen is non-commercial research data and may not be redistributed. Output goes to a folder
outside the repo (default ~/data/asl-citizen/frames); nothing here is committed or uploaded.

Setup (once):  python3 -m venv ~/data/asl-citizen/.venv && ~/data/asl-citizen/.venv/bin/pip install mediapipe opencv-python
Run:           ~/data/asl-citizen/.venv/bin/python scripts/aslcitizen/extract.py \
                   --videos ~/data/asl-citizen/videos --csv ~/data/asl-citizen/splits/train.csv \
                   --glosses HELLO,GOODBYE,YES,NO --per-gloss 30
The CSV is the dataset's split file; its video-file and gloss column names are detected (override with
--video-col / --gloss-col).
"""
import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "src/renderer/public/mediapipe"
FACE_EVERY = 3  # the app looks for a face on every 3rd frame and reuses the box


def find_col(header, wanted, options):
    if wanted:
        return wanted
    low = {h.lower().strip(): h for h in header}
    for o in options:
        for k, v in low.items():
            if o in k:
                return v
    sys.exit(f"cannot find a column like {options} in {header}; pass --video-col / --gloss-col")


def make_landmarker():
    opts = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODELS / "hand_landmarker.task")),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.6,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return vision.HandLandmarker.create_from_options(opts)


def make_face():
    opts = vision.FaceDetectorOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODELS / "face_detector.tflite")),
        running_mode=vision.RunningMode.VIDEO,
        min_detection_confidence=0.5,
    )
    return vision.FaceDetector.create_from_options(opts)


def extract(path, flip):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    hands, face = make_landmarker(), make_face()
    frames, box, i, last_t = [], None, 0, -1
    width = height = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if flip:
            bgr = cv2.flip(bgr, 1)
        height, width = bgr.shape[:2]
        t = int(round(i * 1000.0 / fps))
        t = t if t > last_t else last_t + 1
        last_t = t
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        res = hands.detect_for_video(img, t)
        sample = {"t": t, "hands": []}
        for pts, handed in zip(res.hand_landmarks, res.handedness):
            c = handed[0]
            sample["hands"].append({
                "landmarks": [{"x": p.x, "y": p.y, "z": p.z} for p in pts],
                "handedness": "Left" if c.category_name == "Left" else "Right",
                "score": c.score,
            })
        if i % FACE_EVERY == 0:
            dets = face.detect_for_video(img, t).detections
            best = None
            for d in dets:
                b = d.bounding_box
                cand = {"cx": (b.origin_x + b.width / 2) / width, "cy": (b.origin_y + b.height / 2) / height,
                        "w": b.width / width, "h": b.height / height}
                if best is None or cand["w"] * cand["h"] > best["w"] * best["h"]:
                    best = cand
            if best:
                box = best
        if box:
            sample["face"] = box
        frames.append(sample)
        i += 1
    cap.release()
    hands.close()
    face.close()
    return {"fps": fps, "width": width, "height": height, "frames": frames}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--glosses", required=True, help="comma separated, as spelled in the dataset")
    ap.add_argument("--per-gloss", type=int, default=30)
    ap.add_argument("--out", default=str(Path.home() / "data/asl-citizen/frames"))
    ap.add_argument("--video-col")
    ap.add_argument("--gloss-col")
    ap.add_argument("--flip", action="store_true", help="mirror the video first (if the dataset videos are mirrored)")
    args = ap.parse_args()

    wanted = {g.strip().upper() for g in args.glosses.split(",") if g.strip()}
    rows = list(csv.DictReader(open(args.csv, newline="")))
    vcol = find_col(rows[0].keys(), args.video_col, ["video", "file"])
    gcol = find_col(rows[0].keys(), args.gloss_col, ["gloss"])
    by_gloss = defaultdict(list)
    for r in rows:
        g = r[gcol].strip().upper()
        if g in wanted:
            by_gloss[g].append(r[vcol].strip())
    missing = sorted(wanted - set(by_gloss))
    if missing:
        print(f"glosses not found in the CSV: {missing}")
    for g, files in sorted(by_gloss.items()):
        out_dir = Path(args.out) / g
        out_dir.mkdir(parents=True, exist_ok=True)
        done = 0
        for f in files:
            if done >= args.per_gloss:
                break
            target = out_dir / (Path(f).stem + ".json")
            if target.exists():
                done += 1
                continue
            src = Path(args.videos) / f
            result = extract(src, args.flip) if src.exists() else None
            if not result or not result["frames"]:
                print(f"skip {src}")
                continue
            target.write_text(json.dumps({"gloss": g, "clip": Path(f).stem, **result}))
            done += 1
        print(f"{g}: {done} clips -> {out_dir}")


if __name__ == "__main__":
    main()
