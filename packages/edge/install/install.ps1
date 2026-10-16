# VEXPLOR Edge — install on Windows with one command (docs/edge-install.md). Run in an elevated PowerShell:
#
#   .\install.ps1 -Server https://aas.example.com -Code 7KQ4-M2XD-9PRT [-Proxy http://proxy:3128] [-CaFile corp-ca.pem]
#                 [-CredentialsFile credentials.json] [-Name "Line 1"]
#
# Installs to "C:\Program Files\VEXPLOR Edge", keeps key and queue in "C:\ProgramData\VEXPLOR Edge" (SYSTEM,
# Administrators and the service account only), registers with the one-time code and starts the service through WinSW.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Code,
  [string]$Proxy = "",
  [string]$CaFile = "",
  [string]$CredentialsFile = "",
  [string]$Name = "VEXPLOR Edge"
)
$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an elevated PowerShell (Run as administrator)."
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$program = Join-Path $env:ProgramFiles "VEXPLOR Edge"
$data = Join-Path $env:ProgramData "VEXPLOR Edge"
New-Item -ItemType Directory -Force -Path $program, $data, (Join-Path $data "state"), (Join-Path $data "logs") | Out-Null
Copy-Item (Join-Path $here "vexplor-edge.exe"), (Join-Path $here "vexplor-edge-service.exe"), (Join-Path $here "vexplor-edge-service.xml") $program -Force

# Owner-only state: SYSTEM, Administrators and LocalService (the service account) — nobody else reads the key
icacls $data /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "LOCAL SERVICE:(OI)(CI)M" | Out-Null

$config = [ordered]@{ server = $Server; stateDir = (Join-Path $data "state"); name = $Name }
if ($Proxy) { $config.proxy = $Proxy }
if ($CaFile) { Copy-Item $CaFile (Join-Path $data "ca.pem") -Force; $config.caFile = "ca.pem" }
if ($CredentialsFile) { Copy-Item $CredentialsFile (Join-Path $data "credentials.json") -Force; $config.credentialsFile = "credentials.json" }
$config | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $data "edge.json")

& (Join-Path $program "vexplor-edge.exe") register --config (Join-Path $data "edge.json") --code $Code
if ($LASTEXITCODE -ne 0) { throw "Registration failed — see the message above." }
# Registered as the administrator — hand the state to the service account
icacls (Join-Path $data "state") /grant:r "LOCAL SERVICE:(OI)(CI)M" /T | Out-Null

& (Join-Path $program "vexplor-edge-service.exe") install
& (Join-Path $program "vexplor-edge-service.exe") start
Write-Host "Installed and started the service 'VEXPLOR Edge'. Logs: $data\logs"
Write-Host "Next: approve this device's read list on the server — it reads nothing before that."
