#!/usr/bin/env bash
# Code-only switch for the existing API/Worker pair. No migration, backup,
# snapshot, image pruning, media mutation, or WordPress write is performed.
set -Eeuo pipefail

REVISION="${1:?exact 40-character revision required}"
IMAGE="${2:?immutable image digest required}"
VERSION="${3:?application version required}"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]]
[[ "$IMAGE" =~ ^asia-east1-docker\.pkg\.dev/[^[:space:]]+@sha256:[a-f0-9]{64}$ ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]

APP=/opt/solo-to-china
ENV_FILE="$APP/.env.production"
RELEASE="$APP/upgrades/$REVISION"
SHORT="${REVISION:0:8}"
OLD_API="engine-before-$SHORT"
OLD_WORKER="engine-worker-before-$SHORT"
FAILED_API="engine-failed-$SHORT"
FAILED_WORKER="engine-worker-failed-$SHORT"
[[ -f "$ENV_FILE" && ! -e "$RELEASE/complete" ]]
[[ "$(docker inspect --format '{{.State.Running}}' engine)" == true ]]
[[ "$(docker inspect --format '{{.State.Running}}' engine-worker)" == true ]]
for name in "$OLD_API" "$OLD_WORKER" "$FAILED_API" "$FAILED_WORKER"; do
  if docker ps -a --format '{{.Names}}' | grep -Fxq "$name"; then
    printf 'Container name already exists: %s\n' "$name" >&2
    exit 1
  fi
done
LEGACY=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' engine)
[[ -d "$LEGACY" ]]
install -d -m 0700 "$RELEASE" "$RELEASE/canary-data" "$RELEASE/canary-app-data"
printf '%s\n' "$IMAGE" >"$RELEASE/new-image"
printf '%s\n' "$REVISION" >"$RELEASE/revision"
docker inspect --format '{{.Image}}' engine >"$RELEASE/old-api-image-id"
docker inspect --format '{{.Image}}' engine-worker >"$RELEASE/old-worker-image-id"

docker pull "$IMAGE" >"$RELEASE/image-pull.log" 2>&1
# The API role never creates a database. Initialize only the throwaway
# canary volume before checking the image; the production volume is untouched.
docker run --rm --network none --env-file "$ENV_FILE" \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --volume "$RELEASE/canary-data:/var/lib/solo-to-china" "$IMAGE" \
  node --input-type=module -e \
    'import {openDatabase} from "./src/db.mjs";const db=openDatabase(process.env.DATABASE_PATH);db.close()' \
  >"$RELEASE/canary-bootstrap.log" 2>&1
docker run --detach --name "engine-canary-$SHORT" --restart no --network none \
  --env-file "$ENV_FILE" --env CMS_PROCESS_ROLE=api \
  --env "ENGINE_IMAGE=$IMAGE" --env "APP_REVISION=$REVISION" \
  --env ALLOW_PRODUCTION_DATABASE_BOOTSTRAP=true --env HOST=0.0.0.0 --env PORT=8080 \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume "$RELEASE/canary-data:/var/lib/solo-to-china" \
  --volume "$RELEASE/canary-app-data:/app/data" "$IMAGE" >"$RELEASE/canary-container-id"
CANARY_READY=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec --env "EXPECTED_VERSION=$VERSION" "engine-canary-$SHORT" node -e \
    'const r=await fetch("http://127.0.0.1:8080/api/ready");const j=await r.json();if(!r.ok||!j.ready||j.version!==process.env.EXPECTED_VERSION||j.database!=="ready")process.exit(1)' \
    >"$RELEASE/canary-readiness.log" 2>&1; then CANARY_READY=1; break; fi
  [[ "$(docker inspect --format '{{.State.Running}}' "engine-canary-$SHORT")" == true ]] || break
  sleep 2
done
docker logs "engine-canary-$SHORT" >"$RELEASE/canary-container.log" 2>&1 || true
docker stop --time 10 "engine-canary-$SHORT" >/dev/null || true
docker rm "engine-canary-$SHORT" >/dev/null
[[ "$CANARY_READY" == 1 ]]

docker exec engine node --input-type=module -e \
  'const {DatabaseSync}=await import("node:sqlite");const d=new DatabaseSync("/var/lib/solo-to-china/solo-to-china.sqlite",{readOnly:true});const schema=d.prepare("SELECT MAX(version) n FROM schema_migrations").get().n;const active=d.prepare("SELECT COUNT(*) n FROM jobs WHERE status=?").get("running").n;console.log(JSON.stringify({schema,active}));if(schema!==78||active)process.exit(1);d.close()' \
  >"$RELEASE/pre-switch-database.json"

SWITCH_STARTED=0
NEW_API=0
NEW_WORKER=0
rollback() {
  local status=$?
  trap - ERR
  rm -f -- "$RELEASE/complete"
  if [[ "$SWITCH_STARTED" == 1 ]]; then
    if [[ "$NEW_WORKER" == 1 ]]; then
      docker update --restart no engine-worker >/dev/null 2>&1 || true
      docker stop --time 10 engine-worker >/dev/null 2>&1 || true
      docker rename engine-worker "$FAILED_WORKER" >/dev/null 2>&1 || true
    fi
    if [[ "$NEW_API" == 1 ]]; then
      docker update --restart no engine >/dev/null 2>&1 || true
      docker stop --time 10 engine >/dev/null 2>&1 || true
      docker rename engine "$FAILED_API" >/dev/null 2>&1 || true
    fi
    if docker ps -a --format '{{.Names}}' | grep -Fxq "$OLD_API"; then
      docker rename "$OLD_API" engine >/dev/null 2>&1 || true
      docker start engine >/dev/null 2>&1 || true
      docker network connect solo-to-china engine >/dev/null 2>&1 || true
    fi
    if docker ps -a --format '{{.Names}}' | grep -Fxq "$OLD_WORKER"; then
      docker rename "$OLD_WORKER" engine-worker >/dev/null 2>&1 || true
      docker start engine-worker >/dev/null 2>&1 || true
    fi
    if [[ -f "$RELEASE/.env.production.before-image-pin" ]]; then
      cp "$RELEASE/.env.production.before-image-pin" "$ENV_FILE"
    fi
  fi
  printf 'Code-only switch failed; rollback attempted. Records: %s\n' "$RELEASE" >&2
  exit "$status"
}
trap rollback ERR

SWITCH_STARTED=1
docker update --restart no engine-worker >/dev/null
docker stop --time 30 engine-worker >/dev/null
docker rename engine-worker "$OLD_WORKER"
docker network disconnect solo-to-china engine
docker update --restart no engine >/dev/null
docker stop --time 30 engine >/dev/null
docker rename engine "$OLD_API"

docker run --detach --name engine --restart unless-stopped --network none \
  --env-file "$ENV_FILE" --env CMS_PROCESS_ROLE=api \
  --env "ENGINE_IMAGE=$IMAGE" --env "APP_REVISION=$REVISION" \
  --env HOST=0.0.0.0 --env PORT=8080 \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume solo_to_china_data:/var/lib/solo-to-china \
  --volume "$LEGACY:/app/data" "$IMAGE" >"$RELEASE/new-api-container-id"
NEW_API=1
READY=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec --env "EXPECTED_VERSION=$VERSION" engine node -e \
    'const h=await(await fetch("http://127.0.0.1:8080/api/health")).json();const r=await(await fetch("http://127.0.0.1:8080/api/ready")).json();if(h.version!==process.env.EXPECTED_VERSION||h.contentStrategy.version!=="3.9"||!r.ready||r.version!==process.env.EXPECTED_VERSION||r.database!=="ready")process.exit(1)' \
    >"$RELEASE/new-api-readiness.log" 2>&1; then READY=1; break; fi
  [[ "$(docker inspect --format '{{.State.Running}}' engine)" == true ]] || break
  sleep 2
done
[[ "$READY" == 1 ]]
docker network disconnect none engine
docker network connect solo-to-china engine

docker run --detach --name engine-worker --restart unless-stopped --network solo-to-china \
  --env-file "$ENV_FILE" --env CMS_PROCESS_ROLE=worker \
  --env "ENGINE_IMAGE=$IMAGE" --env "APP_REVISION=$REVISION" \
  --env HOST=0.0.0.0 --env PORT=8080 \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume solo_to_china_data:/var/lib/solo-to-china \
  --volume "$LEGACY:/app/data" "$IMAGE" >"$RELEASE/new-worker-container-id"
NEW_WORKER=1
WORKER_READY=0
for ((attempt=0; attempt<30; attempt++)); do
  [[ "$(docker inspect --format '{{.State.Running}}' engine-worker)" == true ]] || break
  if docker logs engine-worker 2>&1 | grep -F 'worker.ready' >/dev/null; then
    WORKER_READY=1; break
  fi
  sleep 2
done
[[ "$WORKER_READY" == 1 ]]
docker logs --tail 30 engine-worker >"$RELEASE/new-worker-log.log" 2>&1

PUBLIC_READY=0
for ((attempt=0; attempt<30; attempt++)); do
  if curl --fail --silent --show-error https://engine.solotochina.com/api/health >"$RELEASE/public-health.json" \
    && curl --fail --silent --show-error https://engine.solotochina.com/api/ready >"$RELEASE/public-ready.json"; then
    PUBLIC_READY=1; break
  fi
  sleep 2
done
[[ "$PUBLIC_READY" == 1 ]]
python3 - "$RELEASE/public-health.json" "$RELEASE/public-ready.json" "$VERSION" <<'PY'
import json, pathlib, sys
health=json.loads(pathlib.Path(sys.argv[1]).read_text())
ready=json.loads(pathlib.Path(sys.argv[2]).read_text())
assert health['version']==sys.argv[3]
assert health['contentStrategy']['version']=='3.9'
assert ready['ready'] is True and ready['database']=='ready' and ready['version']==sys.argv[3]
PY
date --utc --iso-8601=seconds >"$RELEASE/complete"
python3 "$APP/upgrades/8e3b9a467c36ff6a3b0ff33d4b28cf8700db6303/pin-runtime-image.py" "$RELEASE" "$IMAGE" >"$RELEASE/image-pin.log"
trap - ERR
printf 'CODE_ONLY_RELEASE complete revision=%s image=%s rollback_api=%s rollback_worker=%s\n' \
  "$REVISION" "$IMAGE" "$OLD_API" "$OLD_WORKER"
