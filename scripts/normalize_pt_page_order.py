#!/usr/bin/env python3
"""Renumber PT chapter images so page-001 = first page in reading order.

Mediocre downloads with --order desc save page-001 as the *last* page of the cap.
This script reverses filenames in place (two-phase rename) and writes pages-order.json.
"""
import argparse
import json
import re
from pathlib import Path

PAGE_RE = re.compile(r"^page-(\d{3})(\.\w+)$", re.IGNORECASE)


def list_page_files(folder: Path) -> list[Path]:
    files = [f for f in folder.iterdir() if f.is_file() and PAGE_RE.match(f.name)]
    return sorted(files, key=lambda p: int(PAGE_RE.match(p.name).group(1)))


def reverse_page_numbering(folder: Path, dry_run: bool = False) -> int:
    pages = list_page_files(folder)
    if len(pages) < 2:
        return 0
    n = len(pages)
    order_path = folder / "pages-order.json"
    if order_path.exists():
        try:
            data = json.loads(order_path.read_text(encoding="utf-8"))
            if data.get("pageNumbering") == "reading-asc":
                print(f"  skip (already reading-asc): {folder}")
                return 0
        except json.JSONDecodeError:
            pass

    if dry_run:
        print(f"  would reverse {n} pages in {folder}")
        return n

    tmp: list[Path] = []
    for i, src in enumerate(pages):
        m = PAGE_RE.match(src.name)
        ext = m.group(2)
        dest = folder / f"__flip_{i:03d}{ext}"
        src.rename(dest)
        tmp.append(dest)

    for i, src in enumerate(tmp):
        new_num = n - i
        dest = folder / f"page-{new_num:03d}{src.suffix}"
        src.rename(dest)

    order_path.write_text(
        json.dumps(
            {
                "pageNumbering": "reading-asc",
                "reversedFrom": "mediocre-desc-filenames",
                "pageCount": n,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"  reversed {n} pages -> reading-asc: {folder}")
    return n


def iter_chapter_dirs(root: Path) -> list[Path]:
    if list_page_files(root):
        return [root]
    dirs = []
    for d in sorted(root.iterdir()):
        if d.is_dir() and list_page_files(d):
            dirs.append(d)
    return dirs


def main():
    parser = argparse.ArgumentParser(description="Flip page-001..N to reading order (asc filenames)")
    parser.add_argument(
        "root",
        nargs="?",
        default="samples/Gênio Regressado Criador de Itens Mítico",
        help="Chapter folder or parent containing cap-* dirs",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        raise SystemExit(f"Not a directory: {root}")

    total = 0
    for chap in iter_chapter_dirs(root):
        total += reverse_page_numbering(chap, dry_run=args.dry_run)
    print(f"\nDone. Chapters touched: {total if args.dry_run else 'see above'}")


if __name__ == "__main__":
    main()
