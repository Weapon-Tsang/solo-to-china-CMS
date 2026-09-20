param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 9410
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Preview = Join-Path $Root "output/v3-preview"
New-Item -ItemType Directory -Force -Path $Preview | Out-Null

# Never import .env: it may point at live services or contain paid-provider keys.
foreach ($key in @(
    "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY", "VERTEX_AI_ACCESS_TOKEN",
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "EXCEPTION_WEBHOOK_URL", "EXCEPTION_WEBHOOK_TOKEN", "SEARCH_CONSOLE_SITE_URL",
    "WORDPRESS_APPLICATION_PASSWORD", "WORDPRESS_USERNAME", "WORDPRESS_CMS_ARTICLE_ENDPOINT",
    "MODEL_CREDENTIAL_ENCRYPTION_KEY", "BACKUP_OFFSITE_LOCATION", "KIMI_BASE_URL",
    "FRONTEND_CONTRACT_SOURCE_REPOSITORY", "FRONTEND_COMPONENT_REGISTRY_SOURCE",
    "FRONTEND_PAGE_SCHEMA_SOURCE", "FRONTEND_PUBLISH_PACKAGE_SCHEMA_SOURCE",
    "FRONTEND_CONTRACT_COMMIT_SHA", "WORDPRESS_CMS_PUBLISH_PACKAGE_SCHEMA"
)) {
    Remove-Item "Env:$key" -ErrorAction SilentlyContinue
}

$env:NODE_ENV = "development"
$env:HOST = "127.0.0.1"
$env:PORT = [string]$Port
$env:DATABASE_PATH = Join-Path $Preview "cms-preview.sqlite"
$env:SOURCE_UPLOADS_DIR = Join-Path $Preview "source-uploads"
$env:CAPTURE_UPLOADS_DIR = Join-Path $Preview "capture-uploads"
$env:CAPTURE_MEDIA_UPLOADS_DIR = Join-Path $Preview "capture-media-uploads"
$env:GENERATED_MEDIA_DIR = Join-Path $Preview "generated-media"
$env:BACKUP_DIR = Join-Path $Preview "backups"
$env:MAINTENANCE_ENABLED = "false"
$env:PROCESS_ISOLATION_ENABLED = "false"
$env:IMAGE_PROVIDER = "none"
$env:VISUAL_PROVIDER = "none"
$env:WORDPRESS_SITE_URL = ""
$env:PUBLIC_BASE_URL = "http://127.0.0.1:$Port"
$env:PUBLIC_CONTENT_SITE_URL = "http://127.0.0.1:9400"
$env:FRONTEND_CONTRACT_SOURCE_REPOSITORY = Join-Path (Split-Path -Parent $Root) "solo-to-china"
$env:ADMIN_USERNAME = "local-review"
$env:ADMIN_PASSWORD = "LocalOnly-V3-Review-2026!"
$env:SESSION_SECRET = "SoloToChina-V3-isolated-preview-session-only-2026"
$env:ADMIN_TOKEN = ""
$env:CAPTURE_TOKEN = ""

$FrontendPreview = Join-Path (Split-Path -Parent $Root) "solo-to-china/output/v3-preview/wp-application-password.txt"
if (Test-Path -LiteralPath $FrontendPreview) {
    $LocalPassword = (Get-Content -LiteralPath $FrontendPreview -Raw).Trim()
    if ($LocalPassword) {
        $env:WORDPRESS_SITE_URL = "http://127.0.0.1:9400"
        $env:WORDPRESS_USERNAME = "admin"
        $env:WORDPRESS_APPLICATION_PASSWORD = $LocalPassword
        Write-Host "Local WordPress delivery enabled for http://127.0.0.1:9400 only."
    }
}

Push-Location $Root
try {
    if (-not (Test-Path (Join-Path $Root "dist/index.html"))) {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "CMS build failed." }
    }
    Write-Host "CMS local-only preview: http://127.0.0.1:$Port/"
    Write-Host "Isolated database: $env:DATABASE_PATH"
    & node src/server.mjs
    if ($LASTEXITCODE -ne 0) { throw "CMS server exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}
