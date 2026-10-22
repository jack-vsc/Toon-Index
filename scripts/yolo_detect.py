"""Run YOLO text detection on one image; prints JSON to stdout."""
import argparse
import json
import sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description="YOLO detect (single image)")
    p.add_argument("--model", "-m", required=True, help="path to .pt weights")
    p.add_argument("--image", "-i", required=True, help="path to image")
    p.add_argument("--conf", type=float, default=0.25, help="confidence threshold")
    p.add_argument("--imgsz", type=int, default=416, help="inference size")
    args = p.parse_args()

    model_path = Path(args.model)
    image_path = Path(args.image)
    if not model_path.is_file():
        print(json.dumps({"error": f"model not found: {model_path}", "boxes": []}))
        sys.exit(1)
    if not image_path.is_file():
        print(json.dumps({"error": f"image not found: {image_path}", "boxes": []}))
        sys.exit(1)

    from ultralytics import YOLO

    model = YOLO(str(model_path))
    results = model.predict(str(image_path), conf=args.conf, imgsz=args.imgsz, verbose=False)
    boxes = []
    for r in results:
        if r.boxes is None:
            continue
        for b in r.boxes:
            x0, y0, x1, y1 = b.xyxy[0].tolist()
            boxes.append(
                {
                    "box": [int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))],
                    "conf": float(b.conf[0]),
                }
            )
    print(json.dumps({"boxes": boxes}))


if __name__ == "__main__":
    main()
