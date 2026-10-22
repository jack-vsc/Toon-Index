#!/usr/bin/env python3
"""Batch EN (mgread) + PT (Mediocre) -> YOLO dataset for Gênio Regressado caps 43-53."""
import shutil
import sys
from pathlib import Path

# Import from sibling module
sys.path.insert(0, str(Path(__file__).resolve().parent))
from auto_label_difference import auto_label_pages
from split_yolo_dataset import split_dataset

ROOT = Path(__file__).resolve().parents[1]
EN_ROOT = ROOT / "samples" / "The Mythical Weapon Creation of the Regressed Genius Player"
PT_ROOT = ROOT / "samples" / "Gênio Regressado Criador de Itens Mítico"
OUT = ROOT / "models" / "yolo_dataset"

CHAPTERS = list(range(43, 54))


def find_pt_dir(chapter: int) -> Path | None:
    matches = sorted(PT_ROOT.glob(f"cap-{chapter}-*"))
    return matches[0] if matches else None


def main():
    if OUT.exists():
        for sub in ("images", "labels"):
            p = OUT / sub
            if p.exists():
                shutil.rmtree(p)
    (OUT / "images").mkdir(parents=True, exist_ok=True)
    (OUT / "labels").mkdir(parents=True, exist_ok=True)

    total = 0
    for ch in CHAPTERS:
        en_dir = EN_ROOT / f"cap-{ch}"
        pt_dir = find_pt_dir(ch)
        if not en_dir.is_dir():
            print(f"SKIP cap {ch}: EN missing {en_dir}")
            continue
        if not pt_dir or not pt_dir.is_dir():
            print(f"SKIP cap {ch}: PT folder not found")
            continue
        print(f"\n=== Capítulo {ch} ===\n  EN: {en_dir}\n  PT: {pt_dir}")
        before = len(list((OUT / "images").glob("*")))
        auto_label_pages(
            str(en_dir),
            str(pt_dir),
            str(OUT),
            min_area=120,
            max_area_pct=0.45,
            dilate_iterations=10,
            pt_per_en=4,
            en_cover_pages=0,
            pt_cover_pages=0,
            name_prefix=f"cap{ch}-",
        )
        after = len(list((OUT / "images").glob("*")))
        total += after - before

    n_img = len(list((OUT / "images").glob("*")))
    n_lbl = len(list((OUT / "labels").glob("*.txt")))
    n_tr, n_va = split_dataset(OUT, val_chapters=[52, 53])
    print(f"\nDataset final: {n_img} imagens, {n_lbl} labels em {OUT}")
    print(f"Novas nesta execução: ~{total}")
    print(f"Split train/val: {n_tr} train, {n_va} val (caps 52–53 em val)")


if __name__ == "__main__":
    main()
