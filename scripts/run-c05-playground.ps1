param(
    [Parameter(Mandatory = $true)]
    [string]$FrontendRoot,
    [ValidateRange(1024, 65535)]
    [int]$Port = 9417
)

$ErrorActionPreference = "Stop"
$CmsRoot = Split-Path -Parent $PSScriptRoot
$Blueprint = Join-Path $CmsRoot "test/fixtures/wordpress-playground-published-blueprint.json"
$Arguments = @(
    "--yes", "@wp-playground/cli@3.1.52", "server", "--port=$Port",
    "--define-bool", "AUTOMATIC_UPDATER_DISABLED", "true",
    "--define-bool", "WP_AUTO_UPDATE_CORE", "false",
    "--blueprint=$Blueprint",
    "--mount-dir", (Join-Path $FrontendRoot "wp-content/themes/solo-to-china"), "/wordpress/wp-content/themes/solo-to-china",
    "--mount-dir", (Join-Path $FrontendRoot "wp-content/plugins/solo-to-china-tools"), "/wordpress/wp-content/plugins/solo-to-china-tools",
    "--mount-dir", (Join-Path $FrontendRoot "scripts"), "/tmp/solo-to-china-scripts",
    "--mount-dir", (Join-Path $FrontendRoot "wp-content/themes/solo-to-china-child"), "/wordpress/wp-content/themes/solo-to-china-child"
)

& npx @Arguments
if ($LASTEXITCODE -ne 0) { throw "WordPress Playground exited with code $LASTEXITCODE." }
