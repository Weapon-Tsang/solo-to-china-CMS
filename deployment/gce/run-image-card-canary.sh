#!/usr/bin/env bash
# L3/L5 validation of the cost-control + Image Card changes on the production host,
# WITHOUT deploying. Runs one-off containers from the currently running engine image
# with the candidate code bind-mounted read-only over /app/src, /app/config, /app/scripts.
#
#   sudo bash run-image-card-canary.sh /tmp/canary-code.tar.gz
#
# Guarantees:
# - running engine / engine-worker containers are not stopped, restarted or modified;
# - the production database is only opened with SQLite readOnly + PRAGMA query_only;
# - no WordPress, no backfill --execute, no job/queue writes;
# - paid calls: DeepSeek extraction canary (max 2) + Vertex extraction canary (max 1).
set -euo pipefail

CODE_TARBALL="${1:?usage: run-image-card-canary.sh <canary-code.tar.gz>}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="/opt/solo-to-china/replays/image-card-canary-${STAMP}"
ENV_FILE="/opt/solo-to-china/.env.production"
DB="/var/lib/solo-to-china/solo-to-china.sqlite"

WORKER="$(docker ps --filter name=engine-worker --format '{{.Names}}' | head -1)"
[ -n "$WORKER" ] || { echo "engine-worker container not found" >&2; exit 1; }
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$WORKER")"
VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E '(^|_)solo_to_china_data$' | head -1)"
[ -n "$VOLUME" ] || { echo "solo_to_china_data volume not found" >&2; exit 1; }

mkdir -p "$WORK/code" "$WORK/out"
# The runtime image may run as a non-root user; it only needs to write results.
chmod 0777 "$WORK/out"
tar -xzf "$CODE_TARBALL" -C "$WORK/code"
chmod -R a+rX "$WORK/code"
echo "work=$WORK image=$IMAGE volume=$VOLUME"
docker ps --format '{{.Names}} {{.Status}}' > "$WORK/out/containers-before.txt"

# The data volume is mounted read-write only because SQLite needs the WAL -shm file
# to open a live database; every script opens it readOnly with query_only=ON.
run() {
  docker run --rm --env-file "$ENV_FILE" \
    -e DATABASE_PATH="$DB" -e SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
    -e AI_CONCURRENCY_MODE=fixed -e AI_CONCURRENCY_INITIAL=1 -e AI_CONCURRENCY_MAX=1 -e VERTEX_AI_BATCH_ENABLED=false \
    -v "$VOLUME":/var/lib/solo-to-china \
    -v "$WORK/code/src":/app/src:ro -v "$WORK/code/config":/app/config:ro -v "$WORK/code/scripts":/app/scripts:ro \
    -v "$WORK/out":/out "$IMAGE" "$@"
}

echo "== L3 read-only: model ledger audit (last 14 days)"
run node --no-warnings /app/scripts/audit-model-context.mjs "$DB" --since="$(date -u -d '14 days ago' +%Y-%m-%d)" --json \
  > "$WORK/out/model-context-audit.json" || echo "audit failed" >&2

echo "== L3 read-only: context sizes (intake / entity resolution)"
run node --no-warnings /app/scripts/replay-context-sizes.mjs "$DB" > "$WORK/out/context-sizes.json" || echo "context sizes failed" >&2

echo "== L3 read-only: Image Card backfill dry run"
run node --no-warnings /app/scripts/backfill-image-cards.mjs "$DB" > "$WORK/out/backfill-dry-run.txt" || echo "backfill dry run failed" >&2

echo "== L5 DeepSeek extraction canary (max 2 calls, 3 images per call)"
run node --no-warnings /app/scripts/image-card-canary.mjs --provider=deepseek --db="$DB" --pick=6 \
  --max-calls=2 --per-call=3 --out=/out/canary-deepseek.json || true

echo "== L5 Vertex extraction canary (max 1 call, same sample)"
run node --no-warnings /app/scripts/image-card-canary.mjs --provider=vertex --db="$DB" --pick=6 \
  --max-calls=1 --per-call=6 --out=/out/canary-vertex.json || true

docker ps --format '{{.Names}} {{.Status}}' > "$WORK/out/containers-after.txt"
# Copy the sampled images next to the results for manual semantic review.
mkdir -p "$WORK/out/images"
for file in $(cat "$WORK"/out/canary-*.json 2>/dev/null | grep -o '"file": "[^"]*"' | sed 's/.*"file": "\([^"]*\)"/\1/' | sort -u); do
  find /var/lib/docker/volumes/"$VOLUME"/_data/source-uploads -name "$file" -exec cp {} "$WORK/out/images/" \; -quit 2>/dev/null || true
done
chmod -R a+rX "$WORK/out"
echo "RESULTS: $WORK/out"
ls -la "$WORK/out"
# /opt/solo-to-china is root-only; hand a copy to the invoking SSH user so it
# can be fetched with gcloud compute scp without further sudo.
if [ -n "${SUDO_USER:-}" ] && [ -d "/home/$SUDO_USER" ]; then
  PULL="/home/$SUDO_USER/image-card-canary-${STAMP}"
  cp -r "$WORK/out" "$PULL"
  chown -R "$SUDO_USER" "$PULL"
  echo "PULL: $PULL"
  # Fixed path so the fetch command never needs editing.
  LATEST="/home/$SUDO_USER/image-card-canary-latest"
  rm -rf "$LATEST"
  cp -r "$WORK/out" "$LATEST"
  chown -R "$SUDO_USER" "$LATEST"
  echo "LATEST: $LATEST"
fi
