#!/usr/bin/env python3
"""Split flat YOLO dataset into train/val by chapter prefix (capNN-)."""
import argparse
import re
import shutil
from pathlib import Path

CAP_RE = re.compile(r"^cap(\d+)-", re.IGNORECASE)
IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def chapter_from_stem(stem: str) -> int | None:
    m = CAP_RE.match(stem)
    return int(m.group(1)) if m else None


def find_image(images_dir: Path, stem: str) -> Path | None:
    for ext in IMG_EXT:
        p = images_dir / f"{stem}{ext}"
        if p.is_file():
            return p
    return None


def split_dataset(
    root: Path,
    val_chapters: list[int],
    move_flat_to_split: bool = True,
) -> tuple[int, int]:
    images_dir = root / "images"
    labels_dir = root / "labels"
    val_set = set(val_chapters)

    train_img = images_dir / "train"
    val_img = images_dir / "val"
    train_lbl = labels_dir / "train"
    val_lbl = labels_dir / "val"
    for d in (train_img, val_img, train_lbl, val_lbl):
        d.mkdir(parents=True, exist_ok=True)

    # Collect label files from flat labels/ and labels/train|val if re-run
    label_files: list[Path] = []
    for sub in ("", "train", "val"):
        base = labels_dir / sub if sub else labels_dir
        if not base.is_dir():
            continue
        for p in base.iterdir():
            if p.suffix.lower() == ".txt" and p.is_file():
                label_files.append(p)

    seen_stems: set[str] = set()
    n_train = n_val = 0

    for lbl in sorted(set(label_files)):
        stem = lbl.stem
        if stem in seen_stems:
            continue
        seen_stems.add(stem)

        ch = chapter_from_stem(stem)
        is_val = ch in val_set if ch is not None else False

        # Image may live in flat images/, images/train, or images/val
        img = None
        for base in (images_dir, train_img, val_img):
            if base.is_dir():
                img = find_image(base, stem)
                if img:
                    break
        if not img:
            print(f"  warn: no image for {stem}, skipping")
            continue

        dest_img_dir = val_img if is_val else train_img
        dest_lbl_dir = val_lbl if is_val else train_lbl
        dest_img = dest_img_dir / img.name
        dest_lbl = dest_lbl_dir / lbl.name

        if img.resolve() != dest_img.resolve():
            if dest_img.exists():
                dest_img.unlink()
            shutil.move(str(img), str(dest_img))
        if lbl.resolve() != dest_lbl.resolve():
            if dest_lbl.exists():
                dest_lbl.unlink()
            shutil.move(str(lbl), str(dest_lbl))

        if is_val:
            n_val += 1
        else:
            n_train += 1

    # Remove empty flat files leftover in images/ and labels/ root
    if move_flat_to_split:
        for base in (images_dir, labels_dir):
            for p in list(base.iterdir()):
                if p.is_file() and (p.suffix.lower() in IMG_EXT or p.suffix.lower() == ".txt"):
                    p.unlink(missing_ok=True)

    yaml_path = root / "data.yaml"
    yaml_path.write_text(
        f"path: {root.as_posix()}\n"
        "train: images/train\n"
        "val: images/val\n"
        "nc: 1\n"
        "names: ['text']\n",
        encoding="utf-8",
    )
    return n_train, n_val


def main():
    parser = argparse.ArgumentParser(description="Split YOLO dataset by cap number")
    parser.add_argument(
        "--root",
        default="models/yolo_dataset",
        help="Dataset root (images/ + labels/)",
    )
    parser.add_argument(
        "--val-caps",
        default="52,53",
        help="Comma-separated chapter numbers for validation (e.g. 52,53)",
    )
    args = parser.parse_args()
    root = Path(args.root)
    val_chapters = [int(x.strip()) for x in args.val_caps.split(",") if x.strip()]
    n_train, n_val = split_dataset(root, val_chapters)
    print(f"Split done: train={n_train} val={n_val} (val caps: {val_chapters})")
    print(f"Updated {root / 'data.yaml'}")


if __name__ == "__main__":
    main()
