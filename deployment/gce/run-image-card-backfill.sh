#!/usr/bin/env bash
# Image Card backfill for historical source photos on the production database,
# run in a one-off container from the currently deployed image (after release).
#
#   sudo bash run-image-card-backfill.sh dry-run
#   sudo bash run-image-card-backfill.sh execute [LIMIT]      # paid Vertex calls, writes live DB
#   sudo bash run-image-card-backfill.sh rollback              # removes rows from the last ledger
#
# Additive only: assets that already have a real analysis are never overwritten.
# Each written asset id goes to the ledger, so rollback removes exactly those rows.
set -euo pipefail
MODE="${1:-dry-run}"
LIMIT="${2:-1400}"
SRC="$(cd "$(dirname "$0")" && pwd)"
LEDGER_DIR=/opt/solo-to-china/code-releases/image-card-backfill
LEDGER="$LEDGER_DIR/ledger.jsonl"
DB=/var/lib/solo-to-china/solo-to-china.sqlite
IMAGE="$(docker inspect --format '{{.Config.Image}}' engine-worker)"
mkdir -p "$LEDGER_DIR"; chmod 0777 "$LEDGER_DIR"
case "$MODE" in
  dry-run) ARGS=("$DB") ;;
  execute) ARGS=("$DB" --execute --production "--limit=$LIMIT" "--ledger=/ledger/ledger.jsonl") ;;
  rollback) [ -f "$LEDGER" ] || { echo "no ledger at $LEDGER" >&2; exit 1; }; ARGS=("$DB" "--rollback=/ledger/ledger.jsonl") ;;
  *) echo "usage: $0 dry-run | execute [LIMIT] | rollback" >&2; exit 2 ;;
esac
echo "image=$IMAGE mode=$MODE"; df -h / | tail -1
docker run --rm --env-file /opt/solo-to-china/.env.production \
  -e DATABASE_PATH="$DB" -e SOURCE_UPLOADS_DIR=/var/lib/solo-to-china/source-uploads \
  -v solo_to_china_data:/var/lib/solo-to-china \
  -v "$SRC/backfill-image-cards.mjs":/app/scripts/backfill-image-cards.mjs:ro \
  -v "$LEDGER_DIR":/ledger \
  --entrypoint node "$IMAGE" --no-warnings /app/scripts/backfill-image-cards.mjs "${ARGS[@]}"
[ -f "$LEDGER" ] && echo "ledger entries: $(wc -l < "$LEDGER")"
df -h / | tail -1
