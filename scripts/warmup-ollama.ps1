# Warm up the local Ollama vision model.
# Combined with keep_alive=-1 (this plugin sends it on every recognition call),
# once the model is loaded it stays resident, so the next recognition skips the
# cold load that otherwise makes the first attempt time out.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\warmup-ollama.ps1
param(
  [string]$BaseURL = 'http://127.0.0.1:11434',
  [string]$Model   = 'qwen2.5vl:3b',
  [int]$WaitSec    = 180
)

$ErrorActionPreference = 'SilentlyContinue'

# 1) Wait for Ollama to come up.
$deadline = (Get-Date).AddSeconds($WaitSec)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    if ((Invoke-RestMethod "$BaseURL/api/version" -TimeoutSec 3).version) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 3
}
if (-not $ready) { Write-Warning "Ollama not reachable at $BaseURL after ${WaitSec}s"; exit 1 }

# 2) Skip if the model is already resident.
$ps = Invoke-RestMethod "$BaseURL/api/ps" -TimeoutSec 5
if (@($ps.models | Where-Object { $_.name -eq $Model -or $_.model -eq $Model }).Count -gt 0) {
  Write-Output "model $Model already resident"
  exit 0
}

# 3) Load the model with one minimal recognition call (vision encoder included).
$img  = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
$body = @{
  model      = $Model
  messages   = @(@{ role = 'user'; content = @(
      @{ type = 'text'; text = 'ok' },
      @{ type = 'image_url'; image_url = @{ url = "data:image/png;base64,$img" } }
    ) })
  stream     = $false
  max_tokens = 8
  keep_alive = -1
} | ConvertTo-Json -Depth 10

try {
  Invoke-RestMethod "$BaseURL/v1/chat/completions" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 300 | Out-Null
  Write-Output "warmup done: $Model resident"
} catch {
  Write-Warning "warmup failed: $_"
  exit 1
}
