[CmdletBinding()]
param(
  [string]$ProjectId = "project-4bcb9146-c37b-43b0-b11",
  [string]$RuntimeServiceAccount = "solo-to-china-engine@project-4bcb9146-c37b-43b0-b11.iam.gserviceaccount.com",
  [string]$GcloudPath = "gcloud",
  [string]$OutputPath = (Join-Path $PSScriptRoot "..\..\output\dashboard-login.env")
)

$ErrorActionPreference = "Stop"

function New-RandomSecret {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Set-GcpSecret {
  param([string]$Name, [string]$Value)
  $temporaryPath = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($temporaryPath, $Value)
    & $GcloudPath secrets describe $Name --project=$ProjectId *> $null
    if ($LASTEXITCODE -eq 0) {
      & $GcloudPath secrets versions add $Name --data-file=$temporaryPath --project=$ProjectId --quiet
    } else {
      & $GcloudPath secrets create $Name --replication-policy=automatic --data-file=$temporaryPath --project=$ProjectId --quiet
    }
    if ($LASTEXITCODE -ne 0) { throw "Failed to set '$Name'." }
    & $GcloudPath secrets add-iam-policy-binding $Name --member="serviceAccount:$RuntimeServiceAccount" --role="roles/secretmanager.secretAccessor" --project=$ProjectId --quiet | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to authorize the runtime service account for '$Name'." }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
}

$password = New-RandomSecret
$sessionSecret = New-RandomSecret
Set-GcpSecret -Name "solo-to-china-admin-password" -Value $password
Set-GcpSecret -Name "solo-to-china-session-secret" -Value $sessionSecret

New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
[System.IO.File]::WriteAllLines($OutputPath, @("ADMIN_USERNAME=admin", "ADMIN_PASSWORD=$password"))
Write-Output "Dashboard password credentials were stored in Secret Manager and the ignored output file."
