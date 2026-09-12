#!/usr/bin/env bash
# Resume after an image-only startup failure, using a freshly verified, stopped DB.
# No migration, restore, cleanup, or old-code fallback is performed by this helper.
set -Eeuo pipefail
IMAGE="${1:?immutable image required}"
REVISION="${2:?revision required}"
LEGACY="${3:?preserved app-data directory required}"
[[ "$IMAGE" =~ @sha256:[a-f0-9]{64}$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]]
RELEASE="/opt/solo-to-china/upgrades/$REVISION"
[[ "$LEGACY" == /opt/solo-to-china/upgrades/*/legacy-app-data && -d "$LEGACY" ]]
[[ ! -f "$RELEASE/complete" ]]
[[ "$(docker inspect --format '{{.State.Running}}' engine)" == false ]]
python3 - "$RELEASE" <<'PY'
import json, pathlib, sqlite3, sys
release=pathlib.Path(sys.argv[1]); report=release/'migrate.json'
result=json.loads(report.read_text())
assert result['schema']==67 and result['integrity']=='ok'
assert result['foreignKeyErrors']==0 and result['preservedContentFingerprints'] is True
dbpath=pathlib.Path('/var/lib/docker/volumes/solo_to_china_data/_data/solo-to-china.sqlite')
assert dbpath.stat().st_mtime_ns <= report.stat().st_mtime_ns
wal=pathlib.Path(str(dbpath)+'-wal')
assert not wal.exists() or wal.stat().st_size==0, 'Unverified WAL writes exist'
db=sqlite3.connect('file:'+str(dbpath)+'?mode=ro',uri=True)
assert db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0]==67
db.close()
PY
TOKEN="$(curl --fail --silent --header 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')"
printf '%s' "$TOKEN" | docker login --username oauth2accesstoken --password-stdin asia-east1-docker.pkg.dev >/dev/null 2>&1
unset TOKEN
docker pull "$IMAGE" >"$RELEASE/image-pull.log" 2>&1
docker network disconnect solo-to-china engine
docker rename engine "engine-before-${REVISION:0:7}"
docker run --detach --name engine --restart unless-stopped --network none \
  --env-file /opt/solo-to-china/.env.production \
  --env "ENGINE_IMAGE=$IMAGE" --env "APP_REVISION=$REVISION" \
  --env HOST=0.0.0.0 --env PORT=8080 \
  --env DATABASE_PATH=/var/lib/solo-to-china/solo-to-china.sqlite \
  --env BACKUP_DIR=/var/lib/solo-to-china/backups \
  --env GENERATED_MEDIA_DIR=/var/lib/solo-to-china/generated-media \
  --env SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  --volume solo_to_china_data:/var/lib/solo-to-china --volume "$LEGACY:/app/data" "$IMAGE" >/dev/null
READY=0
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec engine node -e 'const r=await fetch("http://127.0.0.1:8080/api/health"); const h=await r.json(); if(!r.ok||h.version!=="2.0.9"||h.contentStrategy.version!=="3.3"||h.captureMediaProtocol.version!==2)process.exit(1)' >"$RELEASE/readiness.log" 2>&1; then
    READY=1; break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' engine)" != true ]]; then break; fi
  sleep 2
done
if [[ "$READY" != 1 ]]; then
  docker update --restart no engine >/dev/null
  docker stop --time 10 engine >/dev/null
  printf 'Readiness failed; retained schema 67 and both containers for inspection.\n' >&2
  exit 1
fi
docker network disconnect none engine
docker network connect solo-to-china engine
date --utc --iso-8601=seconds >"$RELEASE/complete"
printf '[stc-upgrade] COMPLETE revision=%s image=%s records=%s\n' "$REVISION" "$IMAGE" "$RELEASE"
