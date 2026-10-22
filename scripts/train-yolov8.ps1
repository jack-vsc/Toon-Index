Param(
  [int]$epochs = 30,
  [int]$imgsz = 640
)
Set-StrictMode -Version Latest
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $root
. .\.venv\Scripts\Activate.ps1
Write-Host "Launching YOLOv8 training (yolov8n.pt). Args: epochs=$epochs imgsz=$imgsz"
python -m ultralytics import YOLO
python - <<EOF
from ultralytics import YOLO
model = YOLO('yolov8n.pt')
model.train(data=r'./models/yolo_dataset/data.yaml', epochs=$epochs, imgsz=$imgsz, batch=2, device=0)
EOF
Pop-Location
