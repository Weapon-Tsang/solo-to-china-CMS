#!/bin/bash
set -euo pipefail
cd /tmp/stc-family-replay-20260929
mkdir code-final
tar -xzf code-final.tar.gz -C code-final
sudo python3 - <<'PY'
import pathlib,json,hashlib
root=pathlib.Path('/tmp/stc-family-replay-20260929')
image='asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:f6f4fe0039f1ae8d946c4b14a0821bed3ae18872053a81e5b536291a769cd242'
for name,target,sha in [('good','/work/replay.sqlite',None),('bad','/badinput/database.sqlite','8f161a73545bccba6d6bdac659f8bd089126e175895728b20655874760ae28b4')]:
 d=root/('preflight-'+name);d.mkdir(mode=0o700)
 (d/'database.sqlite').symlink_to(target)
 if sha is None:
  with (root/'replay.sqlite').open('rb') as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
 manifest={'image':image,'revision':'a11bcf1711c6b31b52725cdc925c4817629037f3','version':'2.0.71','databaseSha256':sha,'inputSnapshotSha256':'7af3b10dc9196f6efba54b8a4b35eb7577ca9c75282be505625317e19bb6d32a','migration':{'schema':83,'preservedContentFingerprints':True},'testCodeOverlay':hashlib.sha256((root/'code-final.tar.gz').read_bytes()).hexdigest()}
 (d/'manifest.json').write_text(json.dumps(manifest))
PY
IMAGE=asia-east1-docker.pkg.dev/project-4bcb9146-c37b-43b0-b11/solo-to-china/engine@sha256:f6f4fe0039f1ae8d946c4b14a0821bed3ae18872053a81e5b536291a769cd242
for kind in bad good; do
  status=0
  sudo docker run --rm --network none --read-only --entrypoint node \
    --env "STC_UPGRADE_IMAGE=$IMAGE" --env STC_UPGRADE_REVISION=a11bcf1711c6b31b52725cdc925c4817629037f3 --env STC_UPGRADE_VERSION=2.0.71 \
    -v /tmp/stc-family-replay-20260929:/work:ro \
    -v /tmp/stc-family-replay-20260929/code-final/src:/app/src:ro \
    -v /tmp/stc-family-replay-20260929/code-final/scripts:/app/scripts:ro \
    -v /var/lib/docker/volumes/solo_to_china_data/_data/failed-database-1790625139987:/badinput:ro \
    "$IMAGE" /app/scripts/preflight-opportunities.mjs "/work/preflight-$kind" >"final-$kind.json" 2>"final-$kind.log" || status=$?
  printf '%s %s\n' "$kind" "$status" >> final-gate-events.txt
  if [[ "$kind" == bad ]]; then [[ "$status" != 0 ]]; else [[ "$status" == 0 ]]; fi
done
