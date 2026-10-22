Param()
Set-StrictMode -Version Latest
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $root

Write-Host "Creating models folder..."
$models = Join-Path $root "models"
if (-not (Test-Path $models)) { New-Item -ItemType Directory -Path $models | Out-Null }

Write-Host "Creating Python venv..."
if (-not (Test-Path ".venv")) {
  python -m venv .venv
}
Write-Host "Upgrading pip and installing dependencies (ultralytics, opencv-python, onnxruntime-node not needed here)..."
. .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install --upgrade setuptools wheel
pip install ultralytics==8.0.160 opencv-python pillow tqdm

Write-Host "Ensure Node deps for dataset script (canvas)..."
npm install canvas --no-save

Write-Host "Setup complete. Activate venv with: . .\\.venv\\Scripts\\Activate.ps1"
Pop-Location
