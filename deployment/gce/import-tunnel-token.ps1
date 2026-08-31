[CmdletBinding()]
param(
  [string]$ProjectId = "project-4bcb9146-c37b-43b0-b11",

  [string]$RuntimeServiceAccount = "solo-to-china-engine@project-4bcb9146-c37b-43b0-b11.iam.gserviceaccount.com",

  [string]$GcloudPath = "C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.ps1"
)

$ErrorActionPreference = "Stop"
$secureInput = Read-Host "Paste the Cloudflare Docker command or Tunnel token, then press Enter" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureInput)
$plainInput = $null
$temporaryPath = $null

try {
  $plainInput = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $tokenMatch = [regex]::Match($plainInput, "eyJ[A-Za-z0-9_.-]+")
  if (-not $tokenMatch.Success) {
    throw "The pasted value does not contain a Cloudflare Tunnel token."
  }

  $temporaryPath = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($temporaryPath, $tokenMatch.Value)

  & $GcloudPath secrets describe solo-to-china-cloudflare-tunnel-token --project=$ProjectId *> $null
  if ($LASTEXITCODE -eq 0) {
    & $GcloudPath secrets versions add solo-to-china-cloudflare-tunnel-token `
      --data-file=$temporaryPath `
      --project=$ProjectId `
      --quiet
  }
  else {
    & $GcloudPath secrets create solo-to-china-cloudflare-tunnel-token `
      --replication-policy=automatic `
      --data-file=$temporaryPath `
      --project=$ProjectId `
      --quiet
  }

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to save the Cloudflare Tunnel token."
  }

  & $GcloudPath secrets add-iam-policy-binding solo-to-china-cloudflare-tunnel-token `
    --member="serviceAccount:$RuntimeServiceAccount" `
    --role="roles/secretmanager.secretAccessor" `
    --project=$ProjectId `
    --quiet | Out-Null

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to grant the runtime service account access to the Tunnel token."
  }

  Write-Output "Tunnel credential stored successfully."
}
finally {
  if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
    Remove-Item -LiteralPath $temporaryPath -Force
  }

  if ($plainInput) {
    $plainInput = $null
  }

  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
