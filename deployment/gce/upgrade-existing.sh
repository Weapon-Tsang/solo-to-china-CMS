#!/usr/bin/env bash
# Upgrade an existing GCE install. Inject STC_UPGRADE_IMAGE (immutable digest) and
# STC_UPGRADE_PROBE_BASE64 through a generated startup wrapper. Never print env files.
set -Eeuo pipefail
umask 077
IMAGE="${STC_UPGRADE_IMAGE:?immutable image required}"
REVISION="${STC_UPGRADE_REVISION:?revision required}"
VERSION="${STC_UPGRADE_VERSION:?application version required}"
[[ "$IMAGE" =~ @sha256:[a-f0-9]{64}$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
APP=/opt/solo-to-china
ATTEMPT="${STC_UPGRADE_ATTEMPT:-}"
[[ -z "$ATTEMPT" || "$ATTEMPT" =~ ^[0-9]+$ ]]
RELEASE="$APP/upgrades/$REVISION${ATTEMPT:+-attempt-$ATTEMPT}"
OLD="engine-before-${REVISION:0:7}"
OLD_WORKER="engine-worker-before-${REVISION:0:7}"
log() { printf '[stc-upgrade] %s\n' "$*"; }
# Required before *any* production service action, including recovery of a completed release.
# This is an isolated, migrated snapshot prepared with the exact candidate image.
# The post-stop live gate below still rechecks the new fixed write boundary.
PREFLIGHT="${STC_UPGRADE_PREFLIGHT_DIR:?isolated candidate preflight directory required}"
[[ "$PREFLIGHT" == /* && -f "$PREFLIGHT/manifest.json" && -f "$PREFLIGHT/database.sqlite" ]]
timeout --signal=TERM --kill-after=10s 300s docker run --rm --network none --read-only \
  --env "STC_UPGRADE_IMAGE=$IMAGE" --env "STC_UPGRADE_REVISION=$REVISION" --env "STC_UPGRADE_VERSION=$VERSION" \
  --volume "$PREFLIGHT:/preflight:ro" --entrypoint node "$IMAGE" \
  /app/scripts/preflight-opportunities.mjs /preflight
log 'Candidate snapshot business gate passed before maintenance.'
PREPARED="${STC_UPGRADE_PREPARED_DIR:?verified complete backup directory required}"
[[ "$PREFLIGHT" == "$PREPARED/preflight" && -f "$PREFLIGHT/boundary-plan.json" ]]
[[ "${STC_UPGRADE_FAMILY_REPAIR:-}" == approved-six-ids ]]
systemctl start docker
install -d -m 0700 "$RELEASE"
exec 9>"$RELEASE/lock"
flock -n 9 || exit 0
if [[ -f "$RELEASE/complete" ]]; then
  docker start engine engine-worker cloudflared >/dev/null
  log "Already completed $REVISION; existing services started."
  exit 0
fi
# An interrupted attempt needs an operator to inspect the preserved phase and backup.
# Do not rerun the migrations or silently restore an exposed production database.
if [[ -f "$RELEASE/started" ]]; then
  log "Previous attempt needs inspection: $RELEASE (no repeat mutation)."
  exit 1
fi
[[ -f "$APP/.env.production" ]]
MODEL_CREDENTIAL_ENCRYPTION_KEY="$(sed -n 's/^MODEL_CREDENTIAL_ENCRYPTION_KEY=//p' "$APP/.env.production" | tr -d '\r' | tail -1)"
python3 - "$MODEL_CREDENTIAL_ENCRYPTION_KEY" <<'PY'
import base64,re,sys
value=sys.argv[1]
try:
    raw=bytes.fromhex(value) if re.fullmatch(r'[0-9a-fA-F]{64}',value) else base64.b64decode(value,validate=True)
except Exception:
    raw=b''
if len(raw)!=32:
    raise SystemExit('MODEL_CREDENTIAL_ENCRYPTION_KEY is missing or invalid')
PY
unset MODEL_CREDENTIAL_ENCRYPTION_KEY
docker inspect engine >/dev/null
docker inspect cloudflared >/dev/null
WORKER_PRESENT=0
if docker inspect engine-worker >/dev/null 2>&1; then WORKER_PRESENT=1; fi
docker volume inspect solo_to_china_data >/dev/null
docker network inspect solo-to-china >/dev/null
DATA="$(docker volume inspect --format '{{.Mountpoint}}' solo_to_china_data)"
[[ "$DATA" == /var/lib/docker/volumes/solo_to_china_data/_data ]]
AVAILABLE="$(df -B1 --output=avail "$DATA" | tail -1 | tr -d ' ')"
DATA_BYTES="$(stat -c %s "$DATA/solo-to-china.sqlite")"
REQUIRED=$((DATA_BYTES * 3 + 2147483648))
log "Disk preflight available=$AVAILABLE required=$REQUIRED data=$DATA_BYTES"
[[ "$AVAILABLE" -gt "$REQUIRED" ]]
TOKEN="$(curl --fail --silent --show-error --header 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')"
printf '%s' "$TOKEN" | docker login --username oauth2accesstoken --password-stdin asia-east1-docker.pkg.dev >/dev/null 2>&1
unset TOKEN
docker pull "$IMAGE" >"$RELEASE/image-pull.log" 2>&1
printf '%s' "$STC_UPGRADE_PROBE_BASE64" | base64 --decode >"$RELEASE/verify-upgrade.mjs"
OLD_IMAGE="$(docker inspect --format '{{.Image}}' engine)"
# Inspect existence inside the old container before stopping it. Docker versions
# use different error wording for a missing docker-cp source; never parse that.
LEGACY_PRESENT="$(docker exec engine node -e 'process.stdout.write(require("node:fs").existsSync("/app/data") ? "yes" : "no")')"
[[ "$LEGACY_PRESENT" == yes || "$LEGACY_PRESENT" == no ]]
log "Old container /app/data present=$LEGACY_PRESENT"
printf '%s\n' "$OLD_IMAGE" >"$RELEASE/old-image-id"
printf '%s\n' "$IMAGE" >"$RELEASE/new-image"
sha256sum "$APP/.env.production" >"$RELEASE/env.sha256"
touch "$RELEASE/started"
STOPPED=0
RENAMED=0
WORKER_RENAMED=0
WORKER_STOPPED=0
MIGRATED=0
EXPOSED=0
PHASE=legacy-copy
MAINTENANCE_START=0
RECOVERING=0
PROBE="stc-offline-${REVISION:0:7}"
# At most ten minutes for the forward path, reserving five for rollback.
# Docker client timeout alone does not stop its container: recover kills our
# named offline probe before restoring the database.
bounded() {
  local seconds=600
  if [[ "$MAINTENANCE_START" != 0 && "$RECOVERING" == 0 ]]; then
    seconds=$((600 - SECONDS + MAINTENANCE_START))
    [[ "$seconds" -gt 0 ]] || return 124
  elif [[ "$RECOVERING" == 1 ]]; then
    seconds=$((900 - SECONDS + MAINTENANCE_START))
    [[ "$seconds" -gt 0 ]] || return 124
  fi
  timeout --signal=TERM --kill-after=5s "${seconds}s" "$@"
}
DOCKER_BIN="$(type -P docker)"
docker() { bounded "$DOCKER_BIN" "$@"; }
offline() {
  local image="$1" mode="$2"
  PHASE="$mode"
  if ! docker run --rm --name "$PROBE" --network none --env "OLD_IMAGE=$OLD_IMAGE" --env "NEW_VERSION=$VERSION" \
    --volume solo_to_china_data:/var/lib/solo-to-china \
    --volume "$RELEASE:/ops" --volume "$PREPARED:/prepared:ro" --volume "$RELEASE/legacy-app-data:/app/data:ro" \
    "$image" node /ops/verify-upgrade.mjs "$mode" >"$RELEASE/$mode.log" 2>&1; then
    return 1
  fi
  # Only aggregate probe records enter serial logs. No source content or secrets.
  while IFS= read -r line; do if [[ "$line" == '{"stage":'* ]]; then log "$line"; fi; done <"$RELEASE/$mode.log"
  return 0
}
recover() {
  local code=$?
  trap - ERR
  RECOVERING=1
  timeout 10s "$DOCKER_BIN" kill "$PROBE" >/dev/null 2>&1 || true
  timeout 10s "$DOCKER_BIN" wait "$PROBE" >/dev/null 2>&1 || true
  log "Upgrade failed exit=$code phase=$PHASE stopped=$STOPPED renamed=$RENAMED migrated=$MIGRATED exposed=$EXPOSED; details retained in $RELEASE"
  # These probe/copy logs contain no credentials or model output. Only the first
  # error headline is emitted; full diagnostics remain private on the VM.
  if [[ -f "$RELEASE/$PHASE.log" ]]; then
    local headline
    headline="$(grep -m1 -E 'Error:|AssertionError|No such|not found' "$RELEASE/$PHASE.log" | cut -c1-400 || true)"
    if [[ -n "$headline" ]]; then log "Probe headline: $headline"; fi
  fi
  if [[ "$EXPOSED" == 1 ]]; then
    log 'Public service already exposed; preserving current DB for inspection, no automatic data rollback.'
  elif [[ "$STOPPED" == 1 ]]; then
    if [[ "$RENAMED" == 1 ]] && docker inspect engine >/dev/null 2>&1; then
      docker stop --time 30 engine >/dev/null || true
      docker rename engine "engine-failed-${REVISION:0:7}" || true
    fi
    if [[ "$MIGRATED" == 1 ]]; then offline "$IMAGE" restore || { log 'Restore failed; old engine remains stopped.'; exit "$code"; }; fi
    if [[ "$RENAMED" == 1 ]]; then docker rename "$OLD" engine; fi
    docker network connect solo-to-china engine >/dev/null 2>&1 || true
    docker update --restart unless-stopped engine >/dev/null
    docker start engine >/dev/null
    if [[ "$WORKER_RENAMED" == 1 ]]; then
      docker rename "$OLD_WORKER" engine-worker
      docker update --restart unless-stopped engine-worker >/dev/null
      docker start engine-worker >/dev/null
    elif [[ "$WORKER_STOPPED" == 1 ]]; then
      docker update --restart unless-stopped engine-worker >/dev/null
      docker start engine-worker >/dev/null
    fi
    log 'Previous engine restored; failed attempt and all originals retained.'
  fi
  exit "$code"
}
trap recover ERR
log "Stopping engine gracefully; old image=$OLD_IMAGE"
MAINTENANCE_START=$SECONDS
STOPPED=1
docker stop --time 120 engine >/dev/null
docker update --restart no engine >/dev/null
if [[ "$WORKER_PRESENT" == 1 ]]; then
  docker stop --time 120 engine-worker >/dev/null
  WORKER_STOPPED=1
  docker update --restart no engine-worker >/dev/null
  docker rename engine-worker "$OLD_WORKER"
  WORKER_RENAMED=1
fi
mkdir "$RELEASE/legacy-app-data"
# Container-layer capture chunks were not mounted by earlier releases. Preserve the
# complete directory and mount it at its original path in the replacement engine.
if [[ "$LEGACY_PRESENT" == yes ]]; then
  docker cp engine:/app/data/. "$RELEASE/legacy-app-data/" >"$RELEASE/legacy-copy.log" 2>&1
  log 'Preserved old /app/data, including capture upload state.'
else
  log 'Old container has no /app/data; initialized an empty persistent capture-state directory.'
fi
# Hash all immutable uploads/visuals and copied legacy state before and after migration.
CONTENT_ROOTS=("$RELEASE/legacy-app-data")
for directory in "$DATA/source-uploads" "$DATA/generated-media"; do
  if [[ -d "$directory" ]]; then CONTENT_ROOTS+=("$directory"); fi
done
bounded bash -c 'find "$@" -type f -print0 | sort -z | xargs -0 -r sha256sum' _ "${CONTENT_ROOTS[@]}" >"$RELEASE/originals.sha256"
offline "$IMAGE" boundary-backup
MIGRATED=1
offline "$IMAGE" migrate
offline "$IMAGE" family-repair
PHASE=opportunity-audit
docker run --rm --name "$PROBE" --network none --volume solo_to_china_data:/var/lib/solo-to-china \
  "$IMAGE" node /app/scripts/audit-opportunity-qualification.mjs \
  /var/lib/solo-to-china/solo-to-china.sqlite --enforce >"$RELEASE/opportunity-audit.json" 2>"$RELEASE/opportunity-audit.log"
OPPORTUNITY_SUMMARY="$(python3 - "$RELEASE/opportunity-audit.json" <<'PY'
import json,sys
audit=json.load(open(sys.argv[1]))
print(json.dumps({'stage':'opportunity-gate','reconciliation':'not-run',
  'ready':audit['counts']['actionableReadiness']['ready'],
  'evidenceGap':audit['counts']['actionableReadiness']['evidenceGap'],
  'hardViolations':audit['enforcement']['hardViolationCount']}))
PY
)"
log "$OPPORTUNITY_SUMMARY"
bounded sha256sum --check --status "$RELEASE/originals.sha256"
sha256sum --check --status "$RELEASE/env.sha256"
log 'Original media hashes and existing environment preserved.'
docker network disconnect solo-to-china engine
docker rename engine "$OLD"
RENAMED=1
docker run --detach --name engine --restart unless-stopped --network none \
  --env-file "$APP/.env.production" \
  --env "ENGINE_IMAGE=$IMAGE" --env "APP_REVISION=$REVISION" \
  --env CMS_PROCESS_ROLE=api \
  --env CMS_STARTUP_RECONCILIATION_ENABLED=false \
  --env HOST=0.0.0.0 --env PORT=8080 \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume solo_to_china_data:/var/lib/solo-to-china \
  --volume "$RELEASE/legacy-app-data:/app/data" "$IMAGE" >/dev/null
READY=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec --env "EXPECTED_VERSION=$VERSION" engine node -e 'const r=await fetch("http://127.0.0.1:8080/api/ready"); const j=await r.json(); if(!r.ok||!j.ready||j.version!==process.env.EXPECTED_VERSION)process.exit(1)' >"$RELEASE/readiness.log" 2>&1; then
    READY=1; break
  fi
  sleep 2
done
[[ "$READY" == 1 ]]
log 'New container readiness passed on isolated network; connecting public service.'
docker network disconnect none engine
[[ $((SECONDS - MAINTENANCE_START)) -lt 540 ]]
# From this point assume new writes may exist, even if network connect times out.
EXPOSED=1
docker network connect solo-to-china engine
docker start cloudflared >/dev/null
PHASE=worker-start
docker run --detach --name engine-worker --restart unless-stopped --network solo-to-china \
  --env-file "$APP/.env.production" \
  --env "ENGINE_IMAGE=$IMAGE" --env "APP_REVISION=$REVISION" \
  --env CMS_PROCESS_ROLE=worker \
  --env CMS_STARTUP_RECONCILIATION_ENABLED=false \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume solo_to_china_data:/var/lib/solo-to-china \
  --volume "$RELEASE/legacy-app-data:/app/data" "$IMAGE" >"$RELEASE/worker-container-id"
WORKER_READY=0
for ((attempt=0; attempt<30; attempt++)); do
  if [[ "$(docker inspect --format '{{.State.Running}}' engine-worker)" != true ]]; then break; fi
  if docker logs engine-worker 2>&1 | grep -F 'worker.ready' >/dev/null; then WORKER_READY=1; break; fi
  sleep 2
done
[[ "$WORKER_READY" == 1 ]]
date --utc --iso-8601=seconds >"$RELEASE/complete"
# Keep prior containers, images, backups and rehearsal evidence for this release.
log "COMPLETE revision=$REVISION image=$IMAGE rollback_container=$OLD rollback_worker=$OLD_WORKER records=$RELEASE"
log "Maintenance elapsed=$((SECONDS - MAINTENANCE_START))s (authorized maximum 900s)."
