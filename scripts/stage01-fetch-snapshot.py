"""Stream an existing production snapshot over IAP into a local private archive.

This reads a named, already-created snapshot. It does not create a backup or
modify production files. The archive deliberately stays outside the Git tree.
"""

import os
import re
import subprocess
import sys
from pathlib import Path


SNAPSHOT = os.environ.get("STC_STAGE01_SNAPSHOT_NAME", "")
OUTPUT = os.environ.get("STC_STAGE01_ARCHIVE_PATH", "")
if not re.fullmatch(r"solo-to-china-[0-9TZ.\-]+\.snapshot", SNAPSHOT):
    raise SystemExit("Set a verified STC_STAGE01_SNAPSHOT_NAME.")
if not OUTPUT:
    raise SystemExit("Set STC_STAGE01_ARCHIVE_PATH outside the repository.")

destination = Path(OUTPUT).resolve()
checkout = Path(__file__).resolve().parent.parent
if destination.is_relative_to(checkout):
    raise SystemExit("Archive target must stay outside the repository.")
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    raise SystemExit("Archive target already exists; refusing to overwrite it.")

source = f"/var/lib/docker/volumes/solo_to_china_data/_data/backups/{SNAPSHOT}"
remote = f"set -o pipefail; sudo -n tar -C {source} -cf - . | gzip -1"
command = [
    r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd",
    "compute", "ssh", "solo-to-china-engine", "--zone=asia-east1-b",
    "--tunnel-through-iap", f"--command=bash -c '{remote}'", "--ssh-flag=-batch",
]
with destination.open("xb") as archive:
    process = subprocess.run(command, stdout=archive, stderr=subprocess.PIPE, check=False)

size = destination.stat().st_size
with destination.open("rb") as archive:
    gzip_magic = archive.read(2) == b"\x1f\x8b"
print(f"snapshot_stream_exit={process.returncode} bytes={size} gzip_magic={gzip_magic}")
if process.returncode or not gzip_magic:
    print(process.stderr.decode("utf-8", errors="replace")[-1000:], file=sys.stderr)
    raise SystemExit(1)
