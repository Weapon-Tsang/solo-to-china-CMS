# Google Cloud + Cloudflare production deployment

Use one Google Compute Engine VM, a persistent Docker volume, and one Cloudflare Tunnel. The project currently uses SQLite plus an in-process durable queue and scheduler; a stateless Cloud Run revision is not a safe replacement without a database and worker redesign.

## Layout

```text
Chrome extension -- HTTPS + CAPTURE_TOKEN -- capture.example.com
Dashboard -- Cloudflare Access -- engine.example.com
Both hostnames -- Cloudflare Tunnel -- GCE VM / Docker Compose
GCE VM -- service account -- Vertex Imagen
```

`engine.example.com` is the private operator dashboard. Protect it with a Cloudflare Access policy for the founder identity. `capture.example.com` bypasses Access because a Chrome extension fetch cannot depend on an interactive Access challenge; the application permits only health, capture, and per-source status routes on this hostname. Every useful capture route requires `CAPTURE_TOKEN`.

## Before provisioning

1. Choose two Cloudflare-managed hostnames, for example `engine.example.com` and `capture.example.com`.
2. Create a Google Cloud project with billing enabled. Enable Compute Engine, Artifact Registry, Cloud Build, and Vertex AI APIs.
3. Create a VM service account with `roles/aiplatform.user`; attach it to the VM with the `cloud-platform` access scope. Do not create or copy a JSON service-account key.
4. Create a Cloudflare Tunnel, add both public hostnames pointing to `http://engine:8080`, and create a Cloudflare Access application only for `engine.example.com`.
5. Generate independent random `CAPTURE_TOKEN` and `ADMIN_TOKEN` values. The extension receives only the capture token; the dashboard keeps the admin token only in session storage when an action needs it.

## Build and run

From an authenticated Google Cloud shell or workstation, substitute your own values:

```powershell
$project = "YOUR_PROJECT_ID"
$region = "us-central1"
$repo = "solo-to-china"
$image = "$region-docker.pkg.dev/$project/$repo/engine:1.5.0"

gcloud services enable compute.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com aiplatform.googleapis.com --project $project
gcloud artifacts repositories create $repo --repository-format=docker --location=$region --project=$project
gcloud builds submit --tag $image --project=$project
```

Create a small persistent-disk VM, such as `e2-small`, attach the service account above, and do not create a public firewall rule. Copy `docker-compose.yml` and a secret local copy of `.env.production` to `/opt/solo-to-china/` on that VM. Then run:

```bash
cd /opt/solo-to-china
docker compose pull
docker compose up -d
docker compose ps
```

The `solo_to_china_data` Docker volume stores SQLite, verified backups, and generated media. Snapshot the VM persistent disk or copy verified SQLite backups to a private Cloud Storage bucket on an operations schedule.

## Install the extension on every desktop Chrome

Build an origin-pinned package after the capture hostname is live:

```powershell
node scripts/package-extension-cloud.mjs --origin https://capture.example.com
Compress-Archive -Path output/extension-cloud/* -DestinationPath output/solo-to-china-extension.zip -Force
```

Upload the ZIP to the Chrome Web Store as an unlisted extension. Sign in to the same Chrome profile on every desktop and install it from the store. Hosting the backend alone cannot install a browser extension on another device.

In the extension Connection settings use `https://capture.example.com` and paste only `CAPTURE_TOKEN`.

## Production verification

- `https://engine.example.com/api/health` is reachable only after Cloudflare Access authentication.
- `https://capture.example.com/api/health` returns basic health, while `https://capture.example.com/api/dashboard` returns 404.
- The extension can save a manually opened note and poll its own `/api/sources/{id}` status using `CAPTURE_TOKEN`.
- Kimi K2.7 Code is the default on a fresh deployment; dashboard Settings can explicitly switch to Kimi K3 and the top badge should change.
- With Vertex Imagen configured, an article produces 2-5 original visual assets and WordPress receives them as uploaded media attachments.

## Secrets and costs

Keep `.env.production`, Cloudflare Tunnel credentials, Kimi keys, WordPress credentials, and tokens out of Git. Vertex Imagen is disabled by default; enabling it creates billable original images. The implementation uses `imagen-4.0-generate-001` with the attached VM service account and does not require a downloaded Google credential file.
