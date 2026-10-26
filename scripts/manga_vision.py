"""Manga vision server: finds text and speech bubbles on a page and repaints what is under the text.

Models (in models/pretrained, loaded once):
- comictextdetector.pt.onnx: text blocks, text lines and a pixel mask of the lettering (manga-image-translator).
- bubble-seg.pt: YOLOv8 segmentation of speech bubbles (kitsumed/yolov8m_seg-speech-bubble).
- anime-manga-big-lama.pt: LaMa fine-tuned on manga, TorchScript (IOPaint).
- comic-text-and-bubble-detector.onnx (optional): RT-DETR-v2 boxes of bubbles, text in bubbles and text
  outside them (ogkalu/comic-text-and-bubble-detector).

Protocol: one JSON request per line on stdin, one JSON answer per line on stdout, matched by "id".
  {"id": 1, "cmd": "detect", "image": "page.png", "mask": "out-mask.png"}
    -> {"id": 1, "blocks": [...], "bubbles": [...]}  (pixel text mask written to "mask")
  {"id": 2, "cmd": "inpaint", "image": "page.png", "mask": "erase.png", "out": "clean.png"}
    -> {"id": 2, "ok": true}
Run with --test IMAGE to write the detection and a cleaned page next to it.
"""
import json
import os
import sys
import time
import traceback
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models" / "pretrained"

CTD_SIZE = 1024
CTD_CONF = 0.3
CTD_NMS = 0.35
SEG_THRESH = 0.3
LINE_THRESH = 0.3
BUBBLE_CONF = 0.35
BUBBLE_SIZE = 1024
# Tall pages (webtoon strips) are cut into windows about this many times taller than wide.
TILE_ASPECT = 1.5
TEXT_TILE_ASPECTS = (1.5, 2.2, 3.0)
# Text windows overlap more: whether a line is found depends on where the window cuts.
TEXT_TILE_OVERLAP = 0.5
TILE_OVERLAP = 0.3
LAMA_MAX_SIDE = 1024
KINDS_MODEL = "comic-text-and-bubble-detector.onnx"
KINDS_SIZE = 640
KINDS_CONF = 0.4
KINDS_TILE_ASPECT = 1.4
KIND_BUBBLE, KIND_TEXT_IN, KIND_TEXT_OUT = 0, 1, 2


def log(*args):
    print(*args, file=sys.stderr, flush=True)


class Vision:
    def __init__(self):
        import torch  # loads CUDA / cuDNN for onnxruntime too

        import onnxruntime as ort
        from ultralytics import YOLO

        self.torch = torch
        # MI_VISION_DEVICE=cpu: the app's setting for computers without a graphics card.
        on_gpu = torch.cuda.is_available() and os.environ.get("MI_VISION_DEVICE") != "cpu"
        self.device = "cuda" if on_gpu else "cpu"
        t = time.time()
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if self.device == "cuda" else ["CPUExecutionProvider"]
        self.ctd = ort.InferenceSession(str(MODELS / "comictextdetector.pt.onnx"), providers=providers)
        self.bubble = YOLO(str(MODELS / "bubble-seg.pt"))
        self.lama = torch.jit.load(str(MODELS / "anime-manga-big-lama.pt"), map_location=self.device).eval()
        # Optional: boxes only, but it finds the bubbles the segmentation misses (translucent, spiky) and
        # tells lettering inside a bubble from lettering outside it.
        kinds = MODELS / KINDS_MODEL
        self.kinds = ort.InferenceSession(str(kinds), providers=providers) if kinds.exists() else None
        # The first runs on the GPU pick their kernels (seconds); do it before the first page arrives.
        # On the processor there is nothing to pick, and the run itself takes minutes.
        if self.device == "cuda":
            self.detect(np.full((1500, 1000, 3), 255, np.uint8))
        log(f"[vision] models loaded on {self.device} in {time.time() - t:.1f}s")

    # ------------------------------------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------------------------------------

    def detect(self, img):
        """img: RGB uint8. Returns text blocks, bubbles (polygons) and the page's text mask (uint8 0/255)."""
        H, W = img.shape[:2]
        mask = np.zeros((H, W), np.uint8)
        lines = np.zeros((H, W), np.uint8)
        boxes, bubbles = [], []
        # Text at two scales: lettering several times bigger than usual (shouts, title cards) is only
        # found when the window is shrunk further.
        for aspect in TEXT_TILE_ASPECTS:
            for y0, y1 in tiles(W, H, aspect, TEXT_TILE_OVERLAP):
                tile = img[y0:y1]
                b, m, l = self.ctd_tile(tile)
                mask[y0:y1] = np.maximum(mask[y0:y1], m)
                if aspect == TEXT_TILE_ASPECTS[0]:
                    lines[y0:y1] = np.maximum(lines[y0:y1], l)
                for x0, ty0, x1, ty1, conf in b:
                    cut = (y0 > 0 and ty0 <= 2) or (y1 < H and ty1 >= tile.shape[0] - 2)
                    boxes.append([x0, ty0 + y0, x1, ty1 + y0, conf * (0.5 if cut else 1)])
        for y0, y1 in tiles(W, H, TILE_ASPECT):
            tile = img[y0:y1]
            for poly, conf in self.bubble_tile(tile):
                poly = poly + np.array([0, y0], np.float32)
                cut = (y0 > 0 and poly[:, 1].min() <= y0 + 2) or (y1 < H and poly[:, 1].max() >= y1 - 2)
                bubbles.append((poly, conf * (0.5 if cut else 1)))
        boxes = nms_boxes(boxes, 0.3)
        bubbles = dedupe_polys(bubbles, W, H)
        kinds = self.kinds_page(img) if self.kinds else []
        # Bubbles only the box detector saw: the ellipse inside the box keeps to the bubble (a rectangle
        # takes in the artwork around a round or spiky one).
        for kind, conf, box in kinds:
            if kind != KIND_BUBBLE or any(iou(box, poly_box(p))[1] > 0.5 for p, _ in bubbles):
                continue
            x0, y0, x1, y1 = box
            centre, axes = (int((x0 + x1) / 2), int((y0 + y1) / 2)), (max(1, int((x1 - x0) / 2)), max(1, int((y1 - y0) / 2)))
            bubbles.append((cv2.ellipse2Poly(centre, axes, 0, 0, 360, 10).astype(np.float32), conf * 0.9))

        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        regions = [refine_bubble(gray, Region.from_polygon(poly, W, H), mask) for poly, _ in bubbles]
        # Slivers of a bubble detected again grow into copies of it once completed.
        kept_idx = []
        for k in sorted(range(len(regions)), key=lambda k: -regions[k].area):
            area = regions[k].area
            if area and all(regions[k].overlap(regions[j]) < 0.7 * area for j in kept_idx):
                kept_idx.append(k)
        kept_idx.sort()
        # The outline as detected, before growing over the flat area around it (which can run over
        # lettering next to the bubble): where lettering crosses it.
        drawn = [Region.from_polygon(bubbles[k][0], W, H) for k in kept_idx]
        bubbles = [(regions[k].outline(), bubbles[k][1]) for k in kept_idx]
        regions = [regions[k] for k in kept_idx]

        blocks = []
        queue = [(b, True) for b in boxes]
        while queue:
            (x0, y0, x1, y1, conf), may_split = queue.pop(0)
            x0, y0, x1, y1 = clip_box(x0, y0, x1, y1, W, H)
            if x1 - x0 < 3 or y1 - y0 < 3:
                continue
            tight, line_boxes, letter, pieces = measure_block(mask, lines, (x0, y0, x1, y1))
            # Rough character count: each line holds about width / (0.6 * letter height) characters. Lines
            # not told apart give one tall line and far too few; the pieces of ink are counted then.
            chars = sum(max(1, round((b[2] - b[0]) / (0.6 * letter))) for b in line_boxes) or max(1, round((tight[2] - tight[0]) / (0.6 * letter)))
            chars = max(chars, pieces)
            cx, cy = (tight[0] + tight[2]) // 2, (tight[1] + tight[3]) // 2
            bubble = -1
            best = 0
            area = (tight[3] - tight[1]) * (tight[2] - tight[0])
            for i, region in enumerate(regions):
                inside = region.inside(tight)
                if (region.at(cx, cy) or inside > 0.5 * area) and inside > best:
                    best, bubble = inside, i
            # Lettering the box detector reads as outside any bubble (an aside across a bubble's outline)
            # is not that bubble's.
            if bubble >= 0 and text_kind(tight, kinds) == KIND_TEXT_OUT:
                bubble = -1
            # Lettering across a bubble's outline may be two: a watermark running into the bubble, its lines
            # side by side with the words. The parts in and out become boxes of their own; the model, which
            # reads them, lists both in one block when they are one sentence (an aside across the outline).
            parts = split_at_outline(mask, drawn[bubble], tight) if may_split and 0 <= bubble < len(drawn) else None
            if parts:
                queue[:0] = [([*p, conf], False) for p in parts]
                continue
            blocks.append(
                {
                    "box": [int(v) for v in tight],
                    "lines": [[int(v) for v in b] for b in line_boxes],
                    "letterHeight": float(letter),
                    "glyphs": int(chars),
                    "conf": float(conf),
                    "bubble": bubble,
                }
            )

        blocks = join_blocks(blocks)
        frames = set()
        # System windows and caption boxes are not bubbles to the segmentation model, but their text is
        # centred in them all the same: the closed flat area around a block outside any bubble.
        for b in blocks:
            if b["bubble"] >= 0:
                continue
            frame = frame_around(img, mask, b["box"], b["letterHeight"])
            if frame is None or any(frame.overlap(r) > 0.5 * frame.area for r in regions):
                continue
            b["bubble"] = len(regions)
            frames.add(len(regions))
            regions.append(frame)
            bubbles.append((frame.outline(), 0.0))

        out_bubbles = [
            {
                "box": region.box(),
                "polygon": [[round(float(x), 1), round(float(y), 1)] for x, y in poly],
                "conf": float(conf),
                "frame": k in frames,
            }
            for k, ((poly, conf), region) in enumerate(zip(bubbles, regions))
        ]
        return blocks, out_bubbles, mask

    def kinds_page(self, img):
        """The box detector over the page, in windows (it was trained on pages resized to 640x640, tall
        strips cut up): [(kind, conf, [x0, y0, x1, y1])]."""
        H, W = img.shape[:2]
        found = []
        for y0, y1 in tiles(W, H, KINDS_TILE_ASPECT):
            tile = img[y0:y1]
            x = cv2.resize(tile, (KINDS_SIZE, KINDS_SIZE), interpolation=cv2.INTER_AREA).astype(np.float32).transpose(2, 0, 1)[None] / 255
            size = np.array([[tile.shape[1], tile.shape[0]]], np.int64)
            labels, boxes, scores = self.kinds.run(None, {"images": x, "orig_target_sizes": size})
            for kind, box, conf in zip(labels[0], boxes[0], scores[0]):
                if conf >= KINDS_CONF:
                    x0, by0, x1, by1 = clip_box(box[0], box[1] + y0, box[2], box[3] + y0, W, H)
                    found.append((int(kind), float(conf), [x0, by0, x1, by1]))
        kept = []
        for f in sorted(found, key=lambda f: -f[1]):
            if all(f[0] != k[0] or (iou(f[2], k[2])[0] < 0.5 and iou(f[2], k[2])[1] < 0.8) for k in kept):
                kept.append(f)
        return kept

    def ctd_tile(self, img):
        h, w = img.shape[:2]
        r = min(CTD_SIZE / h, CTD_SIZE / w)
        nw, nh = int(round(w * r)), int(round(h * r))
        canvas = np.zeros((CTD_SIZE, CTD_SIZE, 3), np.uint8)
        canvas[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR if r > 1 else cv2.INTER_AREA)
        x = canvas.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        blk, seg, det = self.ctd.run(None, {"images": x})

        pred = blk[0]
        pred = pred[pred[:, 4] > CTD_CONF]
        boxes = []
        if len(pred):
            cx, cy, bw, bh = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
            conf = pred[:, 4] * pred[:, 5:].max(1)
            xyxy = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], 1) / r
            keep = cv2.dnn.NMSBoxes(
                [[float(a), float(b), float(c - a), float(d - b)] for a, b, c, d in xyxy], conf.tolist(), CTD_CONF * 0.5, CTD_NMS
            )
            for i in np.array(keep).flatten():
                a, b, c, d = xyxy[i]
                boxes.append([float(a), float(b), float(c), float(d), float(conf[i])])

        def back(m):
            m = m[:nh, :nw]
            return cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)

        seg = back(seg[0, 0])
        det = back(det[0, 0])
        return boxes, ((seg > SEG_THRESH) * 255).astype(np.uint8), ((det > LINE_THRESH) * 255).astype(np.uint8)

    def bubble_tile(self, img):
        res = self.bubble.predict(img, imgsz=BUBBLE_SIZE, conf=BUBBLE_CONF, retina_masks=True, verbose=False, device=0 if self.device == "cuda" else "cpu")
        out = []
        for r in res:
            if r.masks is None:
                continue
            for poly, conf in zip(r.masks.xy, r.boxes.conf.tolist()):
                if len(poly) < 3:
                    continue
                poly = np.asarray(poly, np.float32)
                # Bubbles are compact shapes; a ragged or hollow outline is a bad mask.
                area = cv2.contourArea(poly)
                hull = cv2.contourArea(cv2.convexHull(poly))
                if hull > 0 and area / hull >= 0.8:
                    out.append((poly, conf))
        return out

    # ------------------------------------------------------------------------------------------------
    # Inpainting
    # ------------------------------------------------------------------------------------------------

    def inpaint(self, img, mask):
        """img RGB uint8, mask uint8 (>0 = repaint). Each area of the mask is cleaned in its own crop."""
        out = img.copy()
        H, W = mask.shape
        binary = (mask > 0).astype(np.uint8)
        if not binary.any():
            return out
        # Nearby pieces share one crop so LaMa sees them together.
        n, labels, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(binary, np.ones((15, 15), np.uint8)))
        for i in range(1, n):
            x, y, w, h, _ = stats[i]
            margin = max(48, int(max(w, h) * 0.6))
            x0, y0 = max(0, x - margin), max(0, y - margin)
            x1, y1 = min(W, x + w + margin), min(H, y + h + margin)
            region = (labels[y0:y1, x0:x1] == i) & (binary[y0:y1, x0:x1] > 0)
            crop = out[y0:y1, x0:x1]
            filled = self.lama_crop(crop, region.astype(np.uint8))
            crop[region] = filled[region]
        return out

    def lama_crop(self, img, mask):
        torch = self.torch
        h, w = mask.shape
        scale = min(1.0, LAMA_MAX_SIDE / max(h, w))
        if scale < 1:
            small = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            small_mask = cv2.resize(mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
        else:
            small, small_mask = img, mask
        sh, sw = small_mask.shape
        ph, pw = (8 - sh % 8) % 8, (8 - sw % 8) % 8
        padded = np.pad(small, ((0, ph), (0, pw), (0, 0)), mode="symmetric")
        padded_mask = np.pad(small_mask, ((0, ph), (0, pw)), mode="symmetric")
        # The profiling executor recompiles for every new crop size (seconds each); plain execution does not.
        with torch.no_grad(), torch.jit.optimized_execution(False):
            t_img = torch.from_numpy(padded).permute(2, 0, 1)[None].float().div(255).to(self.device)
            t_mask = torch.from_numpy((padded_mask > 0).astype(np.float32))[None, None].to(self.device)
            res = self.lama(t_img, t_mask)[0].permute(1, 2, 0).clamp(0, 1).mul(255).byte().cpu().numpy()
        res = res[:sh, :sw]
        if scale < 1:
            res = cv2.resize(res, (w, h), interpolation=cv2.INTER_CUBIC)
        return res


def tiles(W, H, aspect, overlap=TILE_OVERLAP):
    th = int(W * aspect)
    if H <= th * 1.15:
        return [(0, H)]
    step = int(th * (1 - overlap))
    out = []
    y = 0
    while True:
        y1 = min(H, y + th)
        out.append((max(0, y1 - th), y1))
        if y1 >= H:
            return out
        y += step


def measure_block(seg, line_map, box):
    """Tight box, text lines and letter height of a detected block, from the lettering's pixels.

    The detector's box can clip the ends of a line, so lettering touching it from just outside counts;
    the line map is shrunk (DBNet), so it only tells how many lines there are.
    """
    H, W = seg.shape
    x0, y0, x1, y1 = box
    pad = int(min(x1 - x0, y1 - y0) * 0.3) + 4
    ex0, ey0, ex1, ey1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
    crop = (seg[ey0:ey1, ex0:ex1] > 0).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(crop)
    keep = np.zeros(n, bool)
    ix0, iy0, ix1, iy1 = x0 - ex0, y0 - ey0, x1 - ex0, y1 - ey0
    for i in range(1, n):
        cx, cy, cw, ch, _ = stats[i]
        # Inside the box, or reaching out of it but mostly in its rows (the clipped end of a line).
        if cx < ix1 and cx + cw > ix0 and cy < iy1 and cy + ch > iy0:
            keep[i] = True
    own = keep[labels]
    if not own.any():
        return [x0, y0, x1, y1], [], max(6.0, min(x1 - x0, y1 - y0) * 0.6), 0
    ys, xs = np.nonzero(own)
    # The pixel mask can miss a line of very big lettering; the detector's box (slightly loose) cannot.
    ix, iy = (x1 - x0) * 0.08, (y1 - y0) * 0.08
    tight = [
        min(int(xs.min()) + ex0, int(x0 + ix)),
        min(int(ys.min()) + ey0, int(y0 + iy)),
        max(int(xs.max()) + 1 + ex0, int(x1 - ix)),
        max(int(ys.max()) + 1 + ey0, int(y1 - iy)),
    ]
    rows = own.any(1)
    runs = []
    y = 0
    while y < len(rows):
        if rows[y]:
            start = y
            while y < len(rows) and rows[y]:
                y += 1
            if y - start >= 3:
                runs.append((start, y))
        y += 1
    lines = []
    for a, b in runs:
        cols = np.nonzero(own[a:b].any(0))[0]
        lines.append([int(cols.min()) + ex0, a + ey0, int(cols.max()) + 1 + ex0, b + ey0])
    heights = sorted(b - a for a, b in runs)
    letter = float(np.median(heights)) if heights else float(tight[3] - tight[1])
    # Lines set close together merge into one band of pixels; the line map still separates them.
    shrunk = (line_map[y0:y1, x0:x1] > 0).any(1)
    count = int(np.count_nonzero(np.diff(shrunk.astype(np.int8)) == 1) + shrunk[0])
    if count > len(runs):
        letter = min(letter, (tight[3] - tight[1]) / (count * 1.3))

    letter = max(4.0, letter)
    # Pieces of ink: every word is at least one, however its letters join (script, a merged band of lines).
    specks = max(3, int((letter * 0.12) ** 2))
    pieces = int(sum(1 for i in range(1, n) if keep[i] and stats[i][4] >= specks))
    return tight, lines, letter, pieces


class Region:
    """A mask over part of the page: `mask` covers the window starting at (x0, y0)."""

    def __init__(self, x0, y0, mask):
        self.x0, self.y0, self.mask = int(x0), int(y0), mask.astype(np.uint8)
        self.area = int(self.mask.sum())

    @staticmethod
    def from_polygon(poly, W, H, margin=0.4):
        x0, y0 = poly.min(0)
        x1, y1 = poly.max(0)
        px, py = (x1 - x0) * margin + 8, (y1 - y0) * margin + 8
        wx0, wy0 = int(max(0, x0 - px)), int(max(0, y0 - py))
        wx1, wy1 = int(min(W, x1 + px)), int(min(H, y1 + py))
        mask = np.zeros((wy1 - wy0, wx1 - wx0), np.uint8)
        cv2.fillPoly(mask, [(poly - [wx0, wy0]).astype(np.int32)], 1)
        return Region(wx0, wy0, mask)

    def window(self):
        return self.x0, self.y0, self.x0 + self.mask.shape[1], self.y0 + self.mask.shape[0]

    def box(self):
        ys, xs = np.nonzero(self.mask)
        if not len(xs):
            return [self.x0, self.y0, self.x0, self.y0]
        return [int(xs.min()) + self.x0, int(ys.min()) + self.y0, int(xs.max()) + 1 + self.x0, int(ys.max()) + 1 + self.y0]

    def inside(self, box):
        wx0, wy0, wx1, wy1 = self.window()
        x0, y0, x1, y1 = max(box[0], wx0), max(box[1], wy0), min(box[2], wx1), min(box[3], wy1)
        if x1 <= x0 or y1 <= y0:
            return 0
        return int(self.mask[y0 - self.y0:y1 - self.y0, x0 - self.x0:x1 - self.x0].sum())

    def at(self, x, y):
        wx0, wy0, wx1, wy1 = self.window()
        return wx0 <= x < wx1 and wy0 <= y < wy1 and bool(self.mask[y - self.y0, x - self.x0])

    def overlap(self, other):
        a, b = self.window(), other.window()
        x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
        if x1 <= x0 or y1 <= y0:
            return 0
        m1 = self.mask[y0 - self.y0:y1 - self.y0, x0 - self.x0:x1 - self.x0]
        m2 = other.mask[y0 - other.y0:y1 - other.y0, x0 - other.x0:x1 - other.x0]
        return int((m1 & m2).sum())

    def outline(self):
        contours, _ = cv2.findContours(self.mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return np.zeros((0, 2), np.float32)
        return (max(contours, key=cv2.contourArea)[:, 0, :] + [self.x0, self.y0]).astype(np.float32)


def refine_bubble(gray, region, text):
    """The segmentation crops each mask to its predicted box, which often falls short of the bubble's
    sides. A bubble's interior is flat: grow the mask over the flat area it lies in, unless that area
    runs out into the page (a bubble open on a background of its own colour)."""
    H, W = gray.shape
    ex0, ey0, ex1, ey1 = region.window()
    own = region.mask > 0
    if region.area < 50:
        return region
    g = gray[ey0:ey1, ex0:ex1].astype(np.int16)
    letters = cv2.dilate((text[ey0:ey1, ex0:ex1] > 0).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    sample = g[own & ~letters]
    if len(sample) < 50:
        return region
    level = float(np.median(sample))
    if np.mean(np.abs(sample - level) > 30) > 0.25:
        return region  # not a flat interior (translucent bubble over artwork)
    flat = ((np.abs(g - level) <= 30) | letters).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(flat, connectivity=4)
    core = cv2.erode(own.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    hits = np.bincount(labels[core].ravel(), minlength=n)
    hits[0] = 0
    if not hits.any():
        return region
    best = int(hits.argmax())
    rx, ry, rw, rh, area = stats[best]
    # Leaked into the page: reaches the edges of the search window.
    edges = (rx == 0 and ex0 > 0) + (ry == 0 and ey0 > 0) + (rx + rw == ex1 - ex0 and ex1 < W) + (ry + rh == ey1 - ey0 and ey1 < H)
    if edges >= 2 or area > 2.5 * region.area:
        return region
    grown = cv2.morphologyEx((labels == best).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(grown, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(grown)
    cv2.drawContours(filled, contours, -1, 1, cv2.FILLED)
    out = np.maximum(region.mask, filled)
    # A bubble stays a compact shape no much bigger than the cut mask; anything else ran into the panel.
    contours, _ = cv2.findContours(out, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = cv2.contourArea(cv2.convexHull(np.vstack(contours)))
    if out.sum() > 1.8 * region.area or out.sum() < 0.85 * hull:
        return region
    return Region(ex0, ey0, out)


def frame_around(img, text, box, letter):
    """The closed area of flat colour holding a block of text (a system window, a caption box), or
    None when the text lies on open background or artwork. Colour, not grey level: a light blue window
    and the white glow around it have the same grey."""
    H, W = img.shape[:2]
    x0, y0, x1, y1 = box
    m = int(max(x1 - x0, y1 - y0) * 0.8 + 4 * letter)
    wx0, wy0, wx1, wy1 = max(0, x0 - m), max(0, y0 - m), min(W, x1 + m), min(H, y1 + m)
    g = img[wy0:wy1, wx0:wx1].astype(np.int16)
    letters = cv2.dilate((text[wy0:wy1, wx0:wx1] > 0).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    pad = int(letter * 0.6) + 2
    ring = np.zeros(g.shape[:2], bool)
    ring[max(0, y0 - pad - wy0):y1 + pad - wy0, max(0, x0 - pad - wx0):x1 + pad - wx0] = True
    ring &= ~letters
    sample = g[ring]
    if len(sample) < 50:
        return None
    level = np.median(sample, axis=0)
    near = lambda px: np.abs(px - level).max(-1) <= 28
    # Window decorations (icons, sound effects) share the block's box; most of the ring is still flat.
    if np.mean(near(sample)) < 0.4:
        return None  # the text sits on artwork or a gradient
    flat = (near(g) | letters).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(flat, connectivity=4)
    hits = np.bincount(labels[ring].ravel(), minlength=n)
    hits[0] = 0
    best = int(hits.argmax())
    rx, ry, rw, rh, area = stats[best]
    # Open background runs out of the search window (or off the page); a frame closes around the text.
    if rx == 0 or ry == 0 or rx + rw == wx1 - wx0 or ry + rh == wy1 - wy0:
        return None
    if area < 1.5 * (x1 - x0) * (y1 - y0) or area < 0.6 * rw * rh:
        return None
    grown = cv2.morphologyEx((labels == best).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(grown, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(grown)
    cv2.drawContours(filled, contours, -1, 1, cv2.FILLED)
    return Region(wx0, wy0, filled)


def join_blocks(blocks):
    """The detector sometimes splits one bubble's text in two; lines stacked closely at the same size are one block."""
    blocks = sorted(blocks, key=lambda b: b["box"][1])
    merged = True
    while merged:
        merged = False
        for i, a in enumerate(blocks):
            for j in range(i + 1, len(blocks)):
                b = blocks[j]
                if a["bubble"] != b["bubble"]:
                    continue
                la, lb = a["letterHeight"], b["letterHeight"]
                if max(la, lb) > 1.5 * min(la, lb):
                    continue
                gap = b["box"][1] - a["box"][3]
                overlap = min(a["box"][2], b["box"][2]) - max(a["box"][0], b["box"][0])
                narrow = min(a["box"][2] - a["box"][0], b["box"][2] - b["box"][0])
                if -max(la, lb) < gap < 1.2 * max(la, lb) and overlap > 0.3 * narrow:
                    box = [min(a["box"][0], b["box"][0]), min(a["box"][1], b["box"][1]), max(a["box"][2], b["box"][2]), max(a["box"][3], b["box"][3])]
                    blocks[i] = {
                        "box": box,
                        "lines": a["lines"] + b["lines"],
                        "letterHeight": max(la, lb),
                        "glyphs": a["glyphs"] + b["glyphs"],
                        "conf": max(a["conf"], b["conf"]),
                        "bubble": a["bubble"],
                    }
                    del blocks[j]
                    merged = True
                    break
            if merged:
                break
    return blocks


def clip_box(x0, y0, x1, y1, W, H):
    return int(max(0, x0)), int(max(0, y0)), int(min(W, x1)), int(min(H, y1))


def iou(a, b):
    ix = min(a[2], b[2]) - max(a[0], b[0])
    iy = min(a[3], b[3]) - max(a[1], b[1])
    if ix <= 0 or iy <= 0:
        return 0.0, 0.0
    inter = ix * iy
    aa = (a[2] - a[0]) * (a[3] - a[1])
    bb = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (aa + bb - inter), inter / max(1e-6, min(aa, bb))


def split_at_outline(text, region, box):
    """The boxes of the lettering inside the bubble and outside it, when both parts are sizeable; else None."""
    x0, y0, x1, y1 = box
    ink = text[y0:y1, x0:x1] > 0
    total = int(ink.sum())
    if total < 100:
        return None
    inside = np.zeros_like(ink)
    wx0, wy0, wx1, wy1 = region.window()
    ix0, iy0, ix1, iy1 = max(x0, wx0), max(y0, wy0), min(x1, wx1), min(y1, wy1)
    if ix1 > ix0 and iy1 > iy0:
        inside[iy0 - y0:iy1 - y0, ix0 - x0:ix1 - x0] = region.mask[iy0 - wy0:iy1 - wy0, ix0 - wx0:ix1 - wx0] > 0
    # Letters just touching the outline don't count: a part is clearly on its side of it.
    core_in = cv2.erode(inside.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    core_out = cv2.erode((~inside).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    if (ink & core_in).sum() < 0.2 * total or (ink & core_out).sum() < 0.2 * total:
        return None
    parts = []
    for side in (inside, ~inside):
        ys, xs = np.nonzero(ink & side)
        parts.append([x0 + int(xs.min()), y0 + int(ys.min()), x0 + int(xs.max()) + 1, y0 + int(ys.max()) + 1])
    return parts


def poly_box(poly):
    return [float(poly[:, 0].min()), float(poly[:, 1].min()), float(poly[:, 0].max()), float(poly[:, 1].max())]


def text_kind(box, kinds):
    """KIND_TEXT_IN / KIND_TEXT_OUT for the box detector's text that covers most of `box`, else None."""
    best, kind = 0.6, None
    for k, _, b in kinds:
        if k in (KIND_TEXT_IN, KIND_TEXT_OUT):
            cover = iou(box, b)[1]
            if cover > best:
                best, kind = cover, k
    return kind


def nms_boxes(boxes, thresh):
    """Boxes found in two overlapping tiles: keep the most confident; a box inside another is the same text."""
    boxes = sorted(boxes, key=lambda b: -b[4])
    kept = []
    for b in boxes:
        if all(iou(b, k)[0] < thresh and iou(b, k)[1] < 0.7 for k in kept):
            kept.append(b)
    return kept


def dedupe_polys(polys, W, H):
    polys = sorted(polys, key=lambda p: -p[1])
    kept = []
    for poly, conf in polys:
        box = [poly[:, 0].min(), poly[:, 1].min(), poly[:, 0].max(), poly[:, 1].max()]
        # The same bubble seen in two tiles, or a sliver of it detected again inside it.
        if all(iou(box, k[2])[0] < 0.6 and iou(box, k[2])[1] < 0.75 for k in kept):
            kept.append((poly, conf, box))
    return [(p, c) for p, c, _ in kept]


def read_rgb(path):
    img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"cannot read image: {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def write_png(path, img):
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise ValueError("png encode failed")
    buf.tofile(path)


def handle(vision, req):
    cmd = req.get("cmd")
    if cmd == "ping":
        return {"ok": True}
    if cmd == "detect":
        blocks, bubbles, mask = vision.detect(read_rgb(req["image"]))
        if req.get("mask"):
            write_png(req["mask"], mask)
        return {"blocks": blocks, "bubbles": bubbles}
    if cmd == "inpaint":
        img = read_rgb(req["image"])
        mask = cv2.imdecode(np.fromfile(req["mask"], np.uint8), cv2.IMREAD_GRAYSCALE)
        write_png(req["out"], vision.inpaint(img, mask))
        return {"ok": True}
    raise ValueError(f"unknown command: {cmd}")


def serve():
    vision = Vision()
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            t = time.time()
            res = handle(vision, req)
            log(f"[vision] {req.get('cmd')} {time.time() - t:.2f}s")
        except Exception as err:  # the app shows the message and falls back
            traceback.print_exc(file=sys.stderr)
            res = {"error": f"{type(err).__name__}: {err}"}
        res["id"] = req.get("id")
        print(json.dumps(res), flush=True)


def test(path):
    vision = Vision()
    img = read_rgb(path)
    t = time.time()
    blocks, bubbles, mask = vision.detect(img)
    log(f"detect {time.time() - t:.2f}s: {len(blocks)} blocks, {len(bubbles)} bubbles")
    vis = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    for b in bubbles:
        cv2.polylines(vis, [np.array(b["polygon"], np.int32)], True, (255, 160, 0), 2)
    for b in blocks:
        x0, y0, x1, y1 = b["box"]
        cv2.rectangle(vis, (x0, y0), (x1, y1), (255, 0, 255), 2)
        cv2.putText(vis, f"{b['letterHeight']:.0f}/{b['bubble']}", (x0, max(10, y0 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 1)
    stem = Path(path).with_suffix("")
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else stem.parent
    out.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".jpg", vis)[1].tofile(str(out / f"{stem.name}-detect.jpg"))
    erase = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    t = time.time()
    clean = vision.inpaint(img, erase)
    log(f"inpaint {time.time() - t:.2f}s")
    write_png(str(out / f"{stem.name}-clean.png"), clean)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--test":
        test(sys.argv[2])
    else:
        serve()
