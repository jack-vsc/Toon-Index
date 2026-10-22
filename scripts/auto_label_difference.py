import os
import json
import cv2
import numpy as np
import argparse
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None


def imread_bgr(path: Path | str) -> np.ndarray | None:
    """Load image as BGR uint8. OpenCV builds often lack WebP; use Pillow when needed."""
    p = Path(path)
    if not p.is_file():
        return None
    if p.suffix.lower() == ".webp" and Image is not None:
        try:
            rgb = np.array(Image.open(p).convert("RGB"))
            return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        except OSError:
            return None
    img = cv2.imread(str(p))
    if img is not None:
        return img
    if Image is not None:
        try:
            rgb = np.array(Image.open(p).convert("RGB"))
            return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        except OSError:
            return None
    return None


def _page_num_from_name(path: Path) -> int | None:
    stem = path.stem
    if stem.startswith("page-") and stem[5:].isdigit():
        return int(stem[5:])
    return None


def _list_page_images(folder: Path):
    valid_exts = {".png", ".jpg", ".jpeg", ".webp"}
    files = sorted([f for f in folder.iterdir() if f.suffix.lower() in valid_exts])
    return files


def _trans_page_path(trans_path: Path, page_num: int) -> Path | None:
    for ext in (".webp", ".png", ".jpg", ".jpeg"):
        p = trans_path / f"page-{page_num:03d}{ext}"
        if p.exists():
            return p
    return None


def resolve_pt_order_desc(trans_path: Path, pt_order_desc: bool, pt_order_desc_flag_set: bool) -> bool:
    """If CLI did not force --pt-order-desc, infer from pages-order.json or legacy desc downloads."""
    if pt_order_desc_flag_set:
        return pt_order_desc
    meta = trans_path / "pages-order.json"
    if meta.is_file():
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            numbering = data.get("pageNumbering")
            if numbering == "reading-asc":
                return False
            if numbering in ("mediocre-desc", "desc-filenames"):
                return True
        except json.JSONDecodeError:
            pass
    # Legacy Mediocre --order desc: page-001 = last page of chapter
    return True


def _pt_reading_index_to_file_num(reading_index: int, total_pt: int, pt_order_desc: bool) -> int:
    """reading_index is 1-based from chapter start; files may be named in desc download order."""
    if pt_order_desc:
        return total_pt - reading_index + 1
    return reading_index


def stitch_trans_for_en_page(
    trans_path: Path,
    en_page_num: int,
    target_w: int,
    target_h: int,
    pt_per_en: int,
    en_cover_pages: int = 1,
    pt_cover_pages: int = 1,
    pt_order_desc: bool = False,
    total_pt_pages: int | None = None,
) -> np.ndarray | None:
    """Build one translated image aligned to one EN page (stack N PT pages vertically)."""
    if total_pt_pages is None:
        total_pt_pages = len(_list_page_images(trans_path))

    if en_page_num <= en_cover_pages and pt_per_en <= 1:
        fp = _trans_page_path(trans_path, en_page_num)
        if not fp:
            return None
        img = imread_bgr(fp)
        if img is None:
            return None
        return cv2.resize(img, (target_w, target_h), interpolation=cv2.INTER_LINEAR)

    content_i = en_page_num - en_cover_pages - 1
    pt_reading_start = pt_cover_pages + 1 + content_i * pt_per_en
    pt_reading_end = pt_reading_start + pt_per_en - 1

    parts = []
    for reading_i in range(pt_reading_start, pt_reading_end + 1):
        file_num = _pt_reading_index_to_file_num(reading_i, total_pt_pages, pt_order_desc)
        fp = _trans_page_path(trans_path, file_num)
        if not fp:
            break
        im = imread_bgr(fp)
        if im is None:
            break
        parts.append(im)

    if not parts:
        return None

    # Same width across slices, then vertical stack
    target_slice_w = max(im.shape[1] for im in parts)
    resized = []
    for im in parts:
        h, w = im.shape[:2]
        if w != target_slice_w:
            scale = target_slice_w / w
            im = cv2.resize(im, (target_slice_w, max(1, int(h * scale))), interpolation=cv2.INTER_LINEAR)
        resized.append(im)
    stacked = cv2.vconcat(resized)
    return cv2.resize(stacked, (target_w, target_h), interpolation=cv2.INTER_LINEAR)


def auto_label_pages(
    orig_dir,
    trans_dir,
    output_dir,
    min_area=100,
    max_area_pct=0.5,
    dilate_iterations=12,
    pt_per_en=1,
    en_cover_pages=1,
    pt_cover_pages=1,
    pt_order_desc=False,
    name_prefix="",
    pt_order_desc_flag_set=False,
):
    """
    Compares original (Japanese) manga pages with translated (Portuguese) pages,
    detects where edits (translations) happened, and automatically generates
    YOLO annotation labels and copies the original images to build a high-quality dataset.
    """
    orig_path = Path(orig_dir)
    trans_path = Path(trans_dir)
    out_path = Path(output_dir)
    
    img_out = out_path / "images"
    lbl_out = out_path / "labels"
    
    img_out.mkdir(parents=True, exist_ok=True)
    lbl_out.mkdir(parents=True, exist_ok=True)
    
    # Supported image formats
    valid_exts = {".png", ".jpg", ".jpeg", ".webp"}
    orig_files = _list_page_images(orig_path)
    
    processed_count = 0

    pt_order_desc = resolve_pt_order_desc(trans_path, pt_order_desc, pt_order_desc_flag_set)
    
    align_note = ""
    total_pt = len(_list_page_images(trans_path))
    if pt_per_en > 1:
        align_note = f"\n  Alignment: {pt_per_en} PT pages per EN page (cover pages={en_cover_pages}, PT order desc={pt_order_desc}, total PT={total_pt}).\n"
    print(f"Starting automatic labeling between:\n  Original: {orig_dir}\n  Translated: {trans_dir}{align_note}")
    
    for f_orig in orig_files:
        img_orig = imread_bgr(f_orig)
        if img_orig is None:
            print(f"Error loading {f_orig.name}, skipping.")
            continue

        h_orig, w_orig = img_orig.shape[:2]
        en_page_num = _page_num_from_name(f_orig)
        if en_page_num is None:
            print(f"Skipping {f_orig.name}: cannot parse page number.")
            continue

        if pt_per_en > 1:
            img_trans = stitch_trans_for_en_page(
                trans_path,
                en_page_num,
                w_orig,
                h_orig,
                pt_per_en,
                en_cover_pages,
                pt_cover_pages,
                pt_order_desc,
                total_pt,
            )
            if img_trans is None:
                print(f"Skipping {f_orig.name}: could not build stitched PT image (pages for EN #{en_page_num}).")
                continue
        else:
            f_trans = trans_path / f_orig.name
            if not f_trans.exists():
                alternatives = [trans_path / f"{f_orig.stem}{ext}" for ext in valid_exts]
                found = False
                for alt in alternatives:
                    if alt.exists():
                        f_trans = alt
                        found = True
                        break
                if not found:
                    print(f"Skipping {f_orig.name}: No matching translated file found in {trans_dir}")
                    continue
            img_trans = imread_bgr(f_trans)
            if img_trans is None:
                print(f"Error loading {f_trans.name}, skipping.")
                continue
            if (h_orig, w_orig) != img_trans.shape[:2]:
                img_trans = cv2.resize(img_trans, (w_orig, h_orig), interpolation=cv2.INTER_LINEAR)
            
        # Convert both to grayscale to do difference analysis
        gray_orig = cv2.cvtColor(img_orig, cv2.COLOR_BGR2GRAY)
        gray_trans = cv2.cvtColor(img_trans, cv2.COLOR_BGR2GRAY)
        
        # Compute absolute difference
        diff = cv2.absdiff(gray_orig, gray_trans)
        
        # Threshold diff to get binary mask of changes
        _, thresh = cv2.threshold(diff, 15, 255, cv2.THRESH_BINARY)
        
        # Dilate mask to merge letters/strokes inside bubbles into single bounding boxes
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        dilated = cv2.dilate(thresh, kernel, iterations=dilate_iterations)
        
        # Find contours (bounding boxes of changed areas)
        contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        yolo_labels = []
        total_img_area = w_orig * h_orig
        
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            area = w * h
            
            # Filter out too small objects (noise, single specs) or huge objects (whole page background changes)
            if area < min_area:
                continue
            if area > total_img_area * max_area_pct:
                continue
                
            # YOLO coordinates: class, x_center, y_center, width, height (normalized 0 to 1)
            cx = (x + w / 2) / w_orig
            cy = (y + h / 2) / h_orig
            nw = w / w_orig
            nh = h / h_orig
            
            # Class index for text/bubble is 0
            yolo_labels.append(f"0 {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
            
        if yolo_labels:
            out_stem = f"{name_prefix}{f_orig.stem}" if name_prefix else f_orig.stem
            out_img_path = img_out / f"{out_stem}{f_orig.suffix}"
            cv2.imwrite(str(out_img_path), img_orig)
            
            lbl_name = f"{out_stem}.txt"
            out_lbl_path = lbl_out / lbl_name
            with open(out_lbl_path, "w") as lf:
                lbl_content = "\n".join(yolo_labels)
                lf.write(lbl_content)
                
            processed_count += 1
            print(f"Auto-labeled: {f_orig.name} -> Detected {len(yolo_labels)} text regions.")
        else:
            print(f"No significant changes detected in {f_orig.name}, skipping.")
            
    print(f"\nCompleted! Generated {processed_count} auto-labeled images in: {output_dir}")

if __name__ == "__main__":
    import sys

    parser = argparse.ArgumentParser(description="Manga Difference Auto-Labeler for YOLO")
    parser.add_argument("--orig", "-o", required=True, help="Directory with original raw (Japanese) manga pages")
    parser.add_argument("--trans", "-t", required=True, help="Directory with translated (scanlated Portuguese) manga pages")
    parser.add_argument("--out", "-out", default="models/yolo_dataset", help="Output folder to save YOLO dataset")
    parser.add_argument("--min-area", type=int, default=150, help="Minimum pixel area for a text box")
    parser.add_argument("--max-pct", type=float, default=0.4, help="Maximum percentage of page area for a text box")
    parser.add_argument("--dilate", type=int, default=10, help="Dilate iterations to merge text strokes (higher = bigger boxes)")
    parser.add_argument(
        "--pt-per-en",
        type=int,
        default=1,
        help="How many PT-BR page images to stack vertically per one EN page (e.g. 8 for long webtoon EN strips)",
    )
    parser.add_argument("--en-cover-pages", type=int, default=1, help="First N EN pages matched 1:1 to PT (usually cover)")
    parser.add_argument("--pt-cover-pages", type=int, default=1, help="First N PT pages before content blocks start")
    parser.add_argument(
        "--pt-order-desc",
        action="store_true",
        help="PT page-001 is last in reading order (Mediocre --order desc). Default: infer from pages-order.json or legacy desc.",
    )
    parser.add_argument("--name-prefix", default="", help="Prefix for output image/label names (e.g. cap43-)")
    
    args = parser.parse_args()
    auto_label_pages(
        args.orig,
        args.trans,
        args.out,
        args.min_area,
        args.max_pct,
        args.dilate,
        args.pt_per_en,
        args.en_cover_pages,
        args.pt_cover_pages,
        args.pt_order_desc,
        args.name_prefix,
        "--pt-order-desc" in sys.argv,
    )
