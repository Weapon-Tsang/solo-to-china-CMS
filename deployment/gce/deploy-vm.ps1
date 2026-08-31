[CmdletBinding()]
param(
  [string]$ProjectId = "project-4bcb9146-c37b-43b0-b11",
  [string]$Zone = "asia-east1-b",
  [string]$InstanceName = "solo-to-china-engine",
  [string]$RuntimeServiceAccount = "solo-to-china-engine@project-4bcb9146-c37b-43b0-b11.iam.gserviceaccount.com",
  [string]$GcloudPath = "gcloud"
)

$ErrorActionPreference = "Stop"
$startupScript = Join-Path $PSScriptRoot "startup.sh"

if (-not (Test-Path -LiteralPath $startupScript)) {
  throw "Missing startup script: $startupScript"
}

& $GcloudPath compute instances describe $InstanceName --zone=$Zone --project=$ProjectId *> $null
if ($LASTEXITCODE -eq 0) {
  throw "Instance '$InstanceName' already exists in '$Zone'."
}

& $GcloudPath compute instances create $InstanceName `
  --project=$ProjectId `
  --zone=$Zone `
  --machine-type=e2-small `
  --boot-disk-size=30GB `
  --boot-disk-type=pd-balanced `
  --image-family=debian-12 `
  --image-project=debian-cloud `
  --service-account=$RuntimeServiceAccount `
  --scopes=https://www.googleapis.com/auth/cloud-platform `
  --subnet=solo-to-china-asia `
  --metadata-from-file=startup-script=$startupScript `
  --quiet

if ($LASTEXITCODE -ne 0) {
  throw "Failed to create the VM."
}

Write-Output "Created '$InstanceName'. The startup script installs Docker and deploys the engine through the outbound Cloudflare Tunnel."
