# Google Cloud + Cloudflare production deployment

Use one Google Compute Engine VM, a persistent Docker volume, and one Cloudflare Tunnel. The project currently uses SQLite plus an in-process durable queue and scheduler; a stateless Cloud Run revision is not a safe replacement without a database and worker redesign.

## Existing installation: 2.0.6 to 2.0.7

Use `upgrade-existing.sh` with `verify-upgrade.mjs` for the additive schema 65 to 66 upgrade. Supply an immutable image digest and the exact 40-character Git revision. The helper preserves the active `/app/data` mount, creates and drills a verified paired backup, rehearses schema 66 offline, and connects public traffic only after the isolated 2.0.7 readiness check passes. After deployment, run the processing-gap and media-storage commands in dry-run mode only; review and retain their report IDs without starting historical jobs or deleting Base64.

## Existing installation: 2.0.5 → 2.0.6

Use `upgrade-existing.sh` with `verify-upgrade.mjs` for this schema 59→65 upgrade. `startup.sh` below remains the fresh-install provisioner; it rewrites configuration and does not perform a migration rehearsal. The actual deployment record, immutable image, disk snapshot and results are in [the 2.0.6 rollout record](../../docs/audit/CMS_DEPLOYMENT_2.0.6_2026-09-12.md).

Prepare a startup wrapper that exports `STC_UPGRADE_IMAGE` as the exact `@sha256:` image, `STC_UPGRADE_REVISION` as its 40-character runtime Git commit, and `STC_UPGRADE_PROBE_BASE64` as the base64 contents of `verify-upgrade.mjs`, then includes `upgrade-existing.sh`. These fields contain code and image identity, never credentials. Validate it with `bash -n`; install using `gcloud compute instances add-metadata --metadata-from-file=startup-script=<wrapper>` on the existing instance, then use controlled stop/start. Keep the existing metadata locally in an ignored operations directory before replacement. Wait for the private disk snapshot to be READY first.

This release-specific helper checks free space for backup/drill/table copies, preserves the existing environment, stops the old container with 120 seconds' grace, copies container-layer `/app/data` to `/opt/solo-to-china/upgrades/<revision>/legacy-app-data`, creates and verifies a system snapshot, performs an offline restore drill, and rehearses the migration against the actual backup. It checks integrity, foreign keys, counts and old-column content fingerprints before migrating production. The old container remains stopped as `engine-before-<short-revision>` with restart disabled. The new container mounts the copied `/app/data` at the same path on persistent disk, retaining legacy capture chunks and receipts across container replacement. Keep that directory in future disk backups.

The probe uses no network or application worker. Public traffic is connected only after the new container passes readiness. Before exposure, a failed attempt restores the verified old DB and restarts the paired old container; the failed database is retained. After public exposure, automatic data rollback is disabled to avoid discarding new captures. A post-exposure rollback requires stopping traffic/workers, backing up the new database and files, preserving new captures for reconciliation, then restoring the paired old code/database under maintenance. Do not simply start 2.0.5 against schema 65.

Reports and phases are retained under `/opt/solo-to-china/upgrades/<revision>/`; only aggregate non-secret records marked `[stc-upgrade]` are emitted to serial output. An interrupted attempt with `started` but no `complete` stops on the next boot for inspection; do not delete its marker and repeat blindly. Successful future boots start the existing engine/tunnel and do not reapply migrations or overwrite configuration. No backup pruning or original-media deletion is part of this helper.

Production verification exposed two required details now covered by the helpers: retain a failed database inside its **data mount** to avoid `EXDEV`, and explicitly propagate a failed offline Docker command even inside a Bash `||` recovery context. Before attaching a healthy container to the service network, disconnect its `none` network. `test-runtime-image.sh` now checks actual built-image startup, that network transition using an isolated internal network, and restore across separate Docker mounts; CI runs it after the source release gate.

`resume-verified-upgrade.sh` is a bounded continuation for an image-only failure after migration: it requires a stopped engine, a successful fresh integrity/fingerprint report, schema 65, an unchanged DB mtime, and no unverified WAL writes. It keeps failed containers/data and does not start old code automatically. After successful online checks, `pin-runtime-image.py <release-directory> <immutable-image>` updates only `ENGINE_IMAGE`, retaining the previous private environment file and proving other configuration bytes unchanged. A whole-disk rollback also requires restoring the intended instance startup metadata; it is not included in the disk snapshot.

## Layout

```text
Chrome extension -- HTTPS + CAPTURE_TOKEN -- capture.example.com
Dashboard -- account password -- engine.example.com
Both hostnames -- Cloudflare Tunnel -- GCE VM / Docker Compose
GCE VM -- service account -- Vertex Imagen
```

`engine.example.com` is the private operator dashboard. It uses the application's own account-password sign-in. `capture.example.com` never uses an interactive access challenge because a Chrome extension fetch cannot depend on one; the application permits only health, capture, and per-source status routes on this hostname. Every useful capture route requires `CAPTURE_TOKEN`.

## Before provisioning

1. Choose two Cloudflare-managed hostnames, for example `engine.example.com` and `capture.example.com`.
2. Create a Google Cloud project with billing enabled. Enable Compute Engine, Artifact Registry, Cloud Build, and Vertex AI APIs.
3. Create a VM service account with `roles/aiplatform.user`; attach it to the VM with the `cloud-platform` access scope. Do not create or copy a JSON service-account key.
4. Create a Cloudflare Tunnel and add both public hostnames pointing to `http://engine:8080`. Do not put an interactive Cloudflare Access challenge in front of the dashboard; the application owns dashboard sign-in.
5. Generate independent random `CAPTURE_TOKEN`, `ADMIN_TOKEN`, `ADMIN_PASSWORD`, and `SESSION_SECRET` values. The extension receives only the capture token. Store all dashboard credentials in Secret Manager.

The checked-in Tunnel configuration does not prove that a Cloudflare Rate Limiting rule exists, so the application enforces its own bounded login throttle. It ignores `X-Forwarded-For` and `CF-Connecting-IP` by default. If the Engine is later restricted to a pinned proxy address, set `TRUSTED_PROXY_HEADER=cf-connecting-ip` and list only that proxy IP/CIDR in `TRUSTED_PROXY_SOURCES`; never enable a forwarded header while the Engine is directly reachable from an untrusted network.

The production connector pins `cloudflare/cloudflared:2026.8.2` and uses Cloudflare Tunnel's supported `http2` transport. This avoids the cross-edge response cancellation observed with QUIC on this VM, prevents an unreviewed `latest` image from changing production, and keeps the same outbound-only port 7844 tunnel model. If the network policy changes, run Cloudflare's connectivity pre-check before changing `--protocol`; TCP port 7844 must remain available for HTTP/2.

Backups are versioned system snapshot directories, not standalone SQLite files. Each snapshot contains a `VACUUM INTO` database image, original uploads, generated media, hashes for every file, database-to-file reference mappings, application/content-strategy/schema/code versions, and retention/offsite-policy metadata. Secret values are excluded; the manifest lists only the Secret Manager references that must be restored separately. Before replacing an existing container, `startup.sh` creates and verifies a `pre-upgrade` snapshot. Keep `BACKUP_OFFSITE_LOCATION` and `BACKUP_OFFSITE_RETENTION_DAYS` aligned with the separately managed offsite replication policy; configuring those values records policy but does not itself upload the snapshot.

Verify and drill a snapshot before rollback:

```bash
docker exec engine node src/backup.mjs --verify /var/lib/solo-to-china/backups/solo-to-china-<timestamp>.snapshot
docker exec engine node src/backup.mjs --drill /var/lib/solo-to-china/backups/solo-to-china-<timestamp>.snapshot
```

The drill restores into an isolated temporary directory, checks every manifest hash, opens every database-referenced evidence/draft-media file, and advances one recovered draft through an offline mock delivery boundary. It never initializes a model client or WordPress adapter. A rollback must restore `database.sqlite`, `files/source-uploads`, and `files/generated-media` together to the paths named by the manifest, restore secrets from Secret Manager, and run the exact `requiredCodeRevision`/`requiredApplicationVersion`; never restore only the database over media from another snapshot.

## Build and run

From an authenticated Google Cloud shell or workstation, substitute your own values:

```powershell
$project = "YOUR_PROJECT_ID"
$region = "us-central1"
$repo = "solo-to-china"
$image = "$region-docker.pkg.dev/$project/$repo/engine:2.0.7"

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

The current startup helper uses native `docker run` commands on the VM so the deployment is not coupled to the Debian image's legacy Compose client. The checked-in Compose file remains useful for local administration. The `solo_to_china_data` Docker volume stores SQLite, verified backups, and generated media. Snapshot the VM persistent disk or copy verified SQLite backups to a private Cloud Storage bucket on an operations schedule.

Uploaded videos larger than the inline Gemini request threshold use the private bucket named by `MANUAL_SOURCE_GCS_BUCKET`. Vertex Batch JSONL input/output uses `VERTEX_AI_BATCH_BUCKET` (it may be the same private bucket). Grant the VM service account `roles/storage.objectAdmin` for application staging and grant the Vertex AI service agent (`service-PROJECT_NUMBER@gcp-sa-aiplatform.iam.gserviceaccount.com`) object read/write access on that batch bucket. Enforce public-access prevention and uniform bucket-level access, then apply `video-bucket-lifecycle.json`. The application deletes completed `manual-source-input/` and `vertex-batch/` temporary objects; the lifecycle rule removes abandoned objects after one day. Authorized originals remain in `solo_to_china_data` and are never governed by this bucket policy.

## Install the extension on every desktop Chrome

Build an origin-pinned package after the capture hostname is live:

```powershell
node scripts/package-extension-cloud.mjs --origin https://capture.example.com --token-file output/deployment-tokens.env
Compress-Archive -Path output/extension-cloud/* -DestinationPath output/solo-to-china-extension.zip -Force
```

Upload the ZIP to the Chrome Web Store as an unlisted extension. Sign in to the same Chrome profile on every desktop and install it from the store. Hosting the backend alone cannot install a browser extension on another device.

The cloud package is preconfigured at build time, so the founder does not enter an endpoint or token in the extension UI. Treat the generated package as a private founder extension: its capture credential is embedded in the package and must never be publicly listed or shared.

## Production verification

- `https://engine.example.com` presents the application sign-in screen. Do not use a weak default password on an internet-accessible deployment; the provided provisioning script creates a high-entropy initial password in the ignored local output file.
- `https://capture.example.com/api/health` returns basic health, while `https://capture.example.com/api/dashboard` returns 404.
- The extension can save a manually opened note and poll its own `/api/sources/{id}` status using `CAPTURE_TOKEN`.
- Vertex AI Gemini 3.8 Flash is the default multimodal research and writing model on a fresh deployment. Large text/image extraction and text coverage-audit backlogs use asynchronous Vertex Batch with completion-based updates; video, small tails, and failed items use realtime requests. Kimi K3 and Kimi K2.7 Code remain explicit alternatives in Settings.
- With Gemini 3.1 Flash Image configured, an article produces 2-5 original non-factual visual assets and WordPress receives them as uploaded media attachments.

## Secrets and costs

Keep `.env.production`, Cloudflare Tunnel credentials, Kimi keys, WordPress credentials, and tokens out of Git. Store the dedicated `stc-cms` WordPress Application Password in Secret Manager as `solo-to-china-wordpress-application-password`; the startup script reads its latest version and injects it only into the Engine process environment. Gemini 3.1 Flash Image generation is enabled only when the Vertex service account and project quota are available; rendered images are billable. The implementation uses the VM-attached service account and does not require a downloaded Google credential file.
