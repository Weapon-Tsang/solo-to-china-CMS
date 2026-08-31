[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [string]$RuntimeServiceAccount,

  [string]$GcloudPath = "gcloud",

  [string]$LocalEnvPath = (Join-Path $PSScriptRoot "..\..\.env"),

  [string]$TokenOutputPath = (Join-Path $PSScriptRoot "..\..\output\deployment-tokens.env")
)

$ErrorActionPreference = "Stop"

function Get-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $line = Get-Content -LiteralPath $Path |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -First 1

  if (-not $line) {
    throw "$Name is missing from $Path."
  }

  return $line.Substring($line.IndexOf("=") + 1).Trim()
}

function New-RandomToken {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Set-GcpSecret {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $temporaryPath = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($temporaryPath, $Value)

    & $GcloudPath secrets describe $Name --project=$ProjectId *> $null
    if ($LASTEXITCODE -eq 0) {
      & $GcloudPath secrets versions add $Name --data-file=$temporaryPath --project=$ProjectId --quiet
    }
    else {
      & $GcloudPath secrets create $Name --replication-policy=automatic --data-file=$temporaryPath --project=$ProjectId --quiet
    }

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create or update Secret Manager secret '$Name'."
    }
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }

  & $GcloudPath secrets add-iam-policy-binding $Name `
    --member="serviceAccount:$RuntimeServiceAccount" `
    --role="roles/secretmanager.secretAccessor" `
    --project=$ProjectId `
    --quiet | Out-Null

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to grant the runtime service account access to '$Name'."
  }
}

if (-not (Test-Path -LiteralPath $LocalEnvPath)) {
  throw "Local environment file not found: $LocalEnvPath"
}

$kimiApiKey = Get-DotEnvValue -Path $LocalEnvPath -Name "KIMI_API_KEY"
$captureToken = New-RandomToken
$adminToken = New-RandomToken

Set-GcpSecret -Name "solo-to-china-kimi-api-key" -Value $kimiApiKey
Set-GcpSecret -Name "solo-to-china-capture-token" -Value $captureToken
Set-GcpSecret -Name "solo-to-china-admin-token" -Value $adminToken

$outputDirectory = Split-Path -Parent $TokenOutputPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
[System.IO.File]::WriteAllLines($TokenOutputPath, @(
  "CAPTURE_TOKEN=$captureToken",
  "ADMIN_TOKEN=$adminToken"
))

Write-Output "Created three Secret Manager secrets and saved the generated application tokens to the ignored output directory."
