"""Create a disposable current-production copy for editorial-media-only reconciliation."""
import os
import shutil
import sqlite3

ROOT = "/var/lib/docker/volumes/solo_to_china_data/_data"
SOURCE = f"{ROOT}/solo-to-china.sqlite"
WORK = f"{ROOT}/editorial-media-only-replay-20260923-work.sqlite"

if not os.path.isfile(SOURCE) or os.path.exists(WORK):
    raise SystemExit("Source missing or editorial-media-only work DB already exists")
if shutil.disk_usage(ROOT).free < 4 * 1024**3:
    raise SystemExit("Insufficient space for the editorial-media-only replay")
source = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
try:
    work = sqlite3.connect(WORK)
    try:
        source.backup(work, pages=4096, sleep=0.05)
    finally:
        work.close()
finally:
    source.close()
check = sqlite3.connect(f"file:{WORK}?mode=ro", uri=True)
try:
    integrity = check.execute("PRAGMA quick_check").fetchone()[0]
    foreign_keys = check.execute("PRAGMA foreign_key_check").fetchall()
    active = check.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
    if integrity != "ok" or foreign_keys or active:
        raise RuntimeError(f"Replay copy invalid: {integrity}, FK={len(foreign_keys)}, active={active}")
finally:
    check.close()
print({"work": WORK, "bytes": os.path.getsize(WORK), "integrity": "ok", "foreign_keys": 0,
       "active": active})
