#!/usr/bin/env bash
# Runs against the built artifact with no network or production configuration.
set -Eeuo pipefail
IMAGE="${1:?image required}"
NAME="stc-runtime-smoke-$$-$RANDOM"
DATA="$NAME-data"
OPS="$NAME-ops"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$DATA" "$OPS" >/dev/null 2>&1 || true
  docker network rm "$NAME-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$DATA" >/dev/null
docker volume create "$OPS" >/dev/null
MOUNTS=(--volume "$DATA:/var/lib/solo-to-china" --volume "$OPS:/ops"
  --volume "$PWD/deployment/gce/verify-upgrade.mjs:/ops/verify-upgrade.mjs:ro")
docker run --detach --name "$NAME" --network none "${MOUNTS[@]}" \
  --env CAPTURE_TOKEN=runtime-smoke-capture-token-only \
  --env ADMIN_TOKEN=runtime-smoke-admin-token-only \
  --env ADMIN_PASSWORD=runtime-smoke-password-only \
  --env SESSION_SECRET=runtime-smoke-session-secret-only \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media "$IMAGE" >/dev/null
READY=0
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$NAME" node -e 'const r=await fetch("http://127.0.0.1:8080/api/ready"); if(!r.ok||!(await r.json()).ready)process.exit(1)' >/dev/null 2>&1; then
    READY=1; break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$NAME")" != true ]]; then
    docker logs "$NAME"; exit 1
  fi
  sleep 1
done
[[ "$READY" == 1 ]]
docker network create --internal "$NAME-net" >/dev/null
docker network disconnect none "$NAME"
docker network connect "$NAME-net" "$NAME"
docker exec "$NAME" node -e 'const r=await fetch("http://127.0.0.1:8080/api/ready");if(!r.ok)process.exit(1);console.log("Runtime network handoff passed")'
docker stop --time 5 "$NAME" >/dev/null
docker run --rm --network none "${MOUNTS[@]}" "$IMAGE" node /ops/verify-upgrade.mjs backup
docker run --rm --network none "${MOUNTS[@]}" "$IMAGE" node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/solo-to-china/solo-to-china.sqlite");d.exec("PRAGMA user_version=99");d.close()'
# Data and operations are separate Docker mounts, as in production. A rename to
# /ops would fail EXDEV; rollback must retain its failed DB inside the data mount.
docker run --rm --network none "${MOUNTS[@]}" "$IMAGE" node /ops/verify-upgrade.mjs restore
docker run --rm --network none "${MOUNTS[@]}" "$IMAGE" node -e 'const fs=require("node:fs"),assert=require("node:assert/strict"),{DatabaseSync}=require("node:sqlite");const root="/var/lib/solo-to-china";let d=new DatabaseSync(root+"/solo-to-china.sqlite");assert.equal(d.prepare("PRAGMA user_version").get().user_version,0);d.close();const retained=fs.readdirSync(root).find(x=>x.startsWith("failed-database-"));assert.ok(retained);d=new DatabaseSync(root+"/"+retained+"/database.sqlite");assert.equal(d.prepare("PRAGMA user_version").get().user_version,99);d.close();console.log("Runtime HTTP readiness and rollback across separate Docker mounts passed")'
