#!/usr/bin/env bash
# Upgrade an existing GCE install. Inject STC_UPGRADE_IMAGE (immutable digest) and
# STC_UPGRADE_PROBE_BASE64 through a generated startup wrapper. Never print env files.
set -Eeuo pipefail
umask 077
IMAGE="${STC_UPGRADE_IMAGE:?immutable image required}"
REVISION="${STC_UPGRADE_REVISION:?revision required}"
[[ "$IMAGE" =~ @sha256:[a-f0-9]{64}$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]]
APP=/opt/solo-to-china
ATTEMPT="${STC_UPGRADE_ATTEMPT:-}"
[[ -z "$ATTEMPT" || "$ATTEMPT" =~ ^[0-9]+$ ]]
RELEASE="$APP/upgrades/$REVISION${ATTEMPT:+-attempt-$ATTEMPT}"
OLD="engine-before-${REVISION:0:7}"
log() { printf '[stc-upgrade] %s\n' "$*"; }
systemctl start docker
install -d -m 0700 "$RELEASE"
exec 9>"$RELEASE/lock"
flock -n 9 || exit 0
if [[ -f "$RELEASE/complete" ]]; then
  docker start engine cloudflared >/dev/null
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
docker inspect engine >/dev/null
docker inspect cloudflared >/dev/null
docker volume inspect solo_to_china_data >/dev/null
docker network inspect solo-to-china >/dev/null
DATA="$(docker volume inspect --format '{{.Mountpoint}}' solo_to_china_data)"
[[ "$DATA" == /var/lib/docker/volumes/solo_to_china_data/_data ]]
AVAILABLE="$(df -B1 --output=avail "$DATA" | tail -1 | tr -d ' ')"
DATA_BYTES="$(du -sb --exclude=backups "$DATA" | cut -f1)"
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
MIGRATED=0
EXPOSED=0
PHASE=legacy-copy
offline() {
  local image="$1" mode="$2"
  PHASE="$mode"
  if ! docker run --rm --network none --env "OLD_IMAGE=$OLD_IMAGE" \
    --volume solo_to_china_data:/var/lib/solo-to-china \
    --volume "$RELEASE:/ops" --volume "$RELEASE/legacy-app-data:/app/data:ro" \
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
    if [[ "$MIGRATED" == 1 ]]; then offline "$OLD_IMAGE" restore || { log 'Restore failed; old engine remains stopped.'; exit "$code"; }; fi
    if [[ "$RENAMED" == 1 ]]; then docker rename "$OLD" engine; fi
    docker network connect solo-to-china engine >/dev/null 2>&1 || true
    docker update --restart unless-stopped engine >/dev/null
    docker start engine >/dev/null
    log 'Previous engine restored; failed attempt and all originals retained.'
  fi
  exit "$code"
}
trap recover ERR
log "Stopping engine gracefully; old image=$OLD_IMAGE"
docker stop --time 120 engine >/dev/null
STOPPED=1
docker update --restart no engine >/dev/null
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
find "${CONTENT_ROOTS[@]}" -type f -print0 \
  | sort -z | xargs -0 -r sha256sum >"$RELEASE/originals.sha256"
offline "$OLD_IMAGE" backup
offline "$IMAGE" rehearse
MIGRATED=1
offline "$IMAGE" migrate
sha256sum --check --status "$RELEASE/originals.sha256"
sha256sum --check --status "$RELEASE/env.sha256"
log 'Original media hashes and existing environment preserved.'
docker network disconnect solo-to-china engine
docker rename engine "$OLD"
RENAMED=1
docker run --detach --name engine --restart unless-stopped --network none \
  --env-file "$APP/.env.production" \
  --env "ENGINE_IMAGE=$IMAGE" --env "APP_REVISION=$REVISION" \
  --env HOST=0.0.0.0 --env PORT=8080 \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume solo_to_china_data:/var/lib/solo-to-china \
  --volume "$RELEASE/legacy-app-data:/app/data" "$IMAGE" >/dev/null
READY=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec engine node -e 'const r=await fetch("http://127.0.0.1:8080/api/ready"); const j=await r.json(); if(!r.ok||!j.ready||j.version!=="2.0.6")process.exit(1)' >"$RELEASE/readiness.log" 2>&1; then
    READY=1; break
  fi
  sleep 2
done
[[ "$READY" == 1 ]]
log 'New container readiness passed on isolated network; connecting public service.'
docker network disconnect none engine
docker network connect solo-to-china engine
EXPOSED=1
docker start cloudflared >/dev/null
date --utc --iso-8601=seconds >"$RELEASE/complete"
log "COMPLETE revision=$REVISION image=$IMAGE rollback_container=$OLD records=$RELEASE"
