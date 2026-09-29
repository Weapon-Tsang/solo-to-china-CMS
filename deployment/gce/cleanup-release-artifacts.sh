#!/usr/bin/env bash
# Removes release/replay working copies that filled the production disk to 100%
# on 2026-09-30 (≈31 GB of rehearsal databases, replay work copies and failed
# rollout databases). Dry run by default; --execute deletes.
#
#   sudo bash cleanup-release-artifacts.sh            # list what would be removed
#   sudo bash cleanup-release-artifacts.sh --execute  # remove it
#
# Never touched: the live database, source-uploads, generated-media, the app
# backups/ directory (daily snapshots, pruned by BACKUP_RETENTION), prepared/*/backups
# (pre-release rollback snapshots) and code-releases/ (rollback material).
set -euo pipefail
EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1
OPT=/opt/solo-to-china
VOLUME_ROOT="$(docker volume inspect --format '{{.Mountpoint}}' solo_to_china_data 2>/dev/null || true)"
DAYS="${CLEANUP_MIN_AGE_DAYS:-3}"

candidates() {
  # Replay / canary work directories.
  [ -d "$OPT/replays" ] && find "$OPT/replays" -mindepth 1 -maxdepth 1 -type d -mtime +"$DAYS"
  # Rehearsal copies inside prepared releases; the backups/ rollback snapshot stays.
  [ -d "$OPT/prepared" ] && find "$OPT/prepared" -mindepth 2 -maxdepth 2 -type d -mtime +"$DAYS" \
    \( -name 'boundary-*' -o -name input -o -name preflight \)
  # Rehearsal / pre-repair database copies in upgrade records (small JSON evidence stays).
  [ -d "$OPT/upgrades" ] && find "$OPT/upgrades" -mindepth 2 -maxdepth 2 -type f -mtime +"$DAYS" \
    \( -name 'rehearsal.sqlite*' -o -name 'pre-data-repair.sqlite*' \)
  # Databases retained from failed rollouts.
  [ -n "$VOLUME_ROOT" ] && find "$VOLUME_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'failed-database-*' -mtime +"$DAYS"
  # Temporary replay trees.
  find /tmp -mindepth 1 -maxdepth 1 -type d -name '*replay*' -mtime +"$DAYS" 2>/dev/null
  # Home-directory canary copies.
  find /home -mindepth 2 -maxdepth 2 -type d -name 'image-card-canary-*' -mtime +"$DAYS" 2>/dev/null
  return 0
}

echo "== disk before"; df -h / | tail -1
total=0
while IFS= read -r target; do
  [ -n "$target" ] || continue
  size=$(du -sb "$target" 2>/dev/null | cut -f1); total=$((total + ${size:-0}))
  printf '%8s  %s\n' "$(numfmt --to=iec "${size:-0}")" "$target"
  if [ "$EXECUTE" = 1 ]; then rm -rf -- "$target"; fi
done < <(candidates | sort -u)
echo "== candidates total: $(numfmt --to=iec "$total") (older than ${DAYS} days)"
if [ "$EXECUTE" = 1 ]; then echo "== removed"; df -h / | tail -1; else echo "== dry run only; re-run with --execute to remove"; fi
