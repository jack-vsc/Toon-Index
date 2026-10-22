import pkgutil
# Workaround for Python versions where pkgutil.ImpImporter may be missing (e.g. Python 3.12).
# Some installations of pkg_resources expect pkgutil.ImpImporter to exist; provide a safe fallback.
if not hasattr(pkgutil, "ImpImporter"):
    pkgutil.ImpImporter = getattr(pkgutil, "zipimporter")

import argparse
from pathlib import Path

WEIGHTS_DIR = Path(__file__).resolve().parents[1] / "models" / "weights"
# Do not import YOLO at module import time — we'll import after applying monkeypatches


def resolve_model_weights(model: str) -> str:
    """Use models/weights/ for stock checkpoints; download via Ultralytics if missing."""
    name = Path(model).name
    if Path(model).is_file():
        return str(Path(model).resolve())
    local = WEIGHTS_DIR / name
    if local.is_file():
        return str(local)
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    return str(local)


def parse_args():
    p = argparse.ArgumentParser(
        description="Train YOLO (wrapper)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--data", "-d", default="models/yolo_dataset/data.yaml", help="path to data yaml")
    p.add_argument("--epochs", "-e", type=int, default=20, help="number of epochs")
    p.add_argument("--img", "--imgsz", type=int, dest="imgsz", default=640, help="image size")
    p.add_argument("--batch", "-b", type=int, default=2, help="batch size")
    p.add_argument("--device", type=int, default=0, help="device (GPU id) or -1 for CPU")
    p.add_argument("--model", "-m", default="yolov8n.pt", help="model weights to start from")
    p.add_argument(
        "--project",
        type=str,
        default="runs/train",
        help="ultralytics project (detect runs land under runs/detect/<project>/<name>)",
    )
    p.add_argument("--name", type=str, default=None, help="run name")
    p.add_argument("--exist-ok", action="store_true", help="Allow existing project/name to be overwritten")
    p.add_argument("--resume", action="store_true", help="resume training from last checkpoint of the specified run")
    p.add_argument(
        "--preset",
        choices=("default", "quality", "marathon"),
        default="default",
        help="'quality' tuned run; 'marathon' = quality + very long training, early stop off (patience 0)",
    )
    p.add_argument("--patience", type=int, default=None, help="early-stop patience (epochs without improvement)")
    p.add_argument(
        "--cache",
        choices=("false", "disk", "ram"),
        default=None,
        help="image cache for faster training",
    )
    p.add_argument("--rect", action=argparse.BooleanOptionalAction, default=None, help="rectangular training batches")
    p.add_argument("--cos-lr", action=argparse.BooleanOptionalAction, default=None, help="cosine LR schedule")
    p.add_argument("--optimizer", choices=("SGD", "Adam", "AdamW", "auto"), default=None)
    p.add_argument("--lr0", type=float, default=None, help="initial learning rate")
    p.add_argument("--lrf", type=float, default=None, help="final LR fraction (lr0 * lrf)")
    p.add_argument("--close-mosaic", type=int, default=None, help="disable mosaic for last N epochs")
    p.add_argument("--workers", type=int, default=None, help="dataloader workers")
    return p.parse_args()


def apply_preset(args):
    """Fill unset training knobs from --preset quality / marathon."""
    if args.preset not in ("quality", "marathon"):
        return
    if args.preset == "marathon" and args.epochs == 20:
        args.epochs = 10_000
    elif args.epochs == 20:
        args.epochs = 500
    if args.imgsz == 640:
        args.imgsz = 1280
    if args.model == "yolov8n.pt":
        args.model = str(WEIGHTS_DIR / "yolov8s.pt")
    if args.batch == 2:
        args.batch = 2
    if args.patience is None:
        args.patience = 0 if args.preset == "marathon" else 150
    if args.cache is None:
        args.cache = "disk"
    if args.rect is None:
        args.rect = True
    if args.cos_lr is None:
        args.cos_lr = True
    if args.optimizer is None:
        args.optimizer = "AdamW"
    if args.lr0 is None:
        args.lr0 = 0.002
    if args.lrf is None:
        args.lrf = 0.01
    if args.close_mosaic is None:
        args.close_mosaic = 30
    if args.workers is None:
        args.workers = 4


def build_train_kwargs(args):
    apply_preset(args)
    kwargs = {
        "data": args.data,
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "device": args.device,
        "project": args.project,
        "name": args.name,
        "exist_ok": args.exist_ok,
    }
    if args.patience is not None:
        kwargs["patience"] = args.patience
    if args.cache is not None and args.cache != "false":
        kwargs["cache"] = args.cache
    if args.rect is not None:
        kwargs["rect"] = args.rect
    if args.cos_lr is not None:
        kwargs["cos_lr"] = args.cos_lr
    if args.optimizer is not None:
        kwargs["optimizer"] = args.optimizer
    if args.lr0 is not None:
        kwargs["lr0"] = args.lr0
    if args.lrf is not None:
        kwargs["lrf"] = args.lrf
    if args.close_mosaic is not None:
        kwargs["close_mosaic"] = args.close_mosaic
    if args.workers is not None:
        kwargs["workers"] = args.workers
    return kwargs


def main():
    args = parse_args()
    train_kwargs = build_train_kwargs(args)
    # Ensure torch will allow loading ultralytics objects when unpickling weights.
    try:
        import torch
        import importlib
        import inspect
        candidates = []
        for module_name in ("ultralytics.nn", "ultralytics.nn.modules", "ultralytics.nn.tasks", "ultralytics.nn.modules.conv"):
            try:
                mod = importlib.import_module(module_name)
            except Exception:
                continue
            for attr_name in dir(mod):
                try:
                    attr = getattr(mod, attr_name)
                    if inspect.isclass(attr):
                        candidates.append(attr)
                except Exception:
                    continue
        # Add common torch classes
        try:
            tnn = importlib.import_module("torch.nn")
            if hasattr(tnn, "Module"):
                candidates.append(getattr(tnn, "Module"))
            if hasattr(tnn, "Sequential"):
                candidates.append(getattr(tnn, "Sequential"))
        except Exception:
            pass

        # Deduplicate and register
        seen = set()
        to_register = []
        for c in candidates:
            try:
                key = (getattr(c, "__module__", ""), getattr(c, "__name__", ""))
                if key in seen:
                    continue
                seen.add(key)
                to_register.append(c)
            except Exception:
                continue

        for obj in to_register:
            try:
                torch.serialization.add_safe_globals([obj])
            except Exception:
                try:
                    torch.serialization.safe_globals([obj])
                except Exception:
                    pass
    except Exception:
        # best-effort; continue even if registration fails
        pass
    # Monkeypatch torch.load to be permissive for weights-only loading when needed.
    # This forces weights_only=False when available to avoid UnpicklingErrors with Ultralytics checkpoints.
    try:
        if "torch" in globals():
            _orig_torch_load = torch.load

            def _patched_torch_load(f, *args, **kwargs):
                # If caller explicitly passed weights_only, respect it but coerce True->False for safety here.
                if "weights_only" in kwargs:
                    try:
                        kwargs["weights_only"] = False
                        return _orig_torch_load(f, *args, **kwargs)
                    except TypeError:
                        # older torch doesn't accept weights_only kwarg
                        kwargs.pop("weights_only", None)
                        return _orig_torch_load(f, *args, **kwargs)
                # Try to call with weights_only=False when supported; fallback otherwise.
                try:
                    return _orig_torch_load(f, *args, **{**kwargs, "weights_only": False})
                except TypeError:
                    return _orig_torch_load(f, *args, **kwargs)

            torch.load = _patched_torch_load
    except Exception:
        pass

    # Create and train model via ultralytics API
    # Import ultralytics and apply a monkeypatch to its internal safe-load helper so it forces
    # torch.load(..., weights_only=False) when loading checkpoints (works for official weights).
    try:
        import ultralytics
        import importlib
        try:
            tasks_mod = importlib.import_module("ultralytics.nn.tasks")
            def _ultra_torch_safe_load(file):
                try:
                    return torch.load(file, map_location="cpu", weights_only=False), file
                except TypeError:
                    # older torch doesn't accept weights_only kwarg
                    return torch.load(file, map_location="cpu"), file
            # Override if present
            if hasattr(tasks_mod, "torch_safe_load"):
                tasks_mod.torch_safe_load = _ultra_torch_safe_load
        except Exception:
            # best-effort: ignore if module not available
            pass
    except Exception:
        pass
    from ultralytics import YOLO
    if args.resume:
        import os
        last_pt_paths = [
            os.path.join("runs", "detect", "runs", "train", args.name, "weights", "last.pt") if args.name else None,
            os.path.join("runs", "train", args.name, "weights", "last.pt") if args.name else None,
            os.path.join("runs", "detect", "train", args.name, "weights", "last.pt") if args.name else None,
            args.model if args.model.endswith("last.pt") else None
        ]
        last_pt = None
        for p_path in last_pt_paths:
            if p_path and os.path.exists(p_path):
                last_pt = p_path
                break
        if last_pt:
            print(f"Resuming training from: {last_pt}")
            model = YOLO(last_pt)
            resume_kw = {k: v for k, v in train_kwargs.items() if k not in ("name", "exist_ok")}
            model.train(resume=True, **resume_kw)
            return
        else:
            print(f"Warning: Could not locate 'last.pt' to resume training for run '{args.name}'. Falling back to standard training.")
            
    weights = resolve_model_weights(args.model)
    if not Path(weights).is_file():
        print(f"Downloading weights -> {weights}")
        bootstrap = YOLO(Path(weights).name)
        import shutil

        downloaded = Path.cwd() / Path(weights).name
        if downloaded.is_file() and downloaded.resolve() != Path(weights).resolve():
            shutil.move(str(downloaded), weights)
    model = YOLO(weights)
    print("Training with kwargs:", {k: v for k, v in train_kwargs.items() if k != "data"})
    model.train(**train_kwargs)


if __name__ == "__main__":
    main()

