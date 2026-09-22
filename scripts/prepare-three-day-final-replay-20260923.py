"""Create a disposable backup of the current live DB for the final route replay."""
import os
import shutil
import sqlite3

ROOT = "/var/lib/docker/volumes/solo_to_china_data/_data"
SOURCE = f"{ROOT}/solo-to-china.sqlite"
WORK = f"{ROOT}/three-day-final-work.sqlite"

if not os.path.isfile(SOURCE) or os.path.exists(WORK):
    raise SystemExit("Source missing or final work DB already exists")
if shutil.disk_usage(ROOT).free < 4 * 1024**3:
    raise SystemExit("Insufficient space for the final replay")
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
    route = check.execute("SELECT revision,status,content_hash FROM article_drafts WHERE id=?",
                          ("draft_ac2559c3c4c24d0bbee23daf89a2ddf0",)).fetchone()
    if integrity != "ok" or foreign_keys or route[:2] != (5, "qa_failed"):
        raise RuntimeError(f"Final copy invalid: {integrity}, FK={len(foreign_keys)}, route={route}")
finally:
    check.close()
print({"work": WORK, "bytes": os.path.getsize(WORK), "integrity": "ok", "foreign_keys": 0,
       "route": route})
