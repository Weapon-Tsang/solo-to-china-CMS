"""Create a consistent, disposable production-data replay pair.

The source is read-only; the work copy is the only database a rehearsal may edit.
This intentionally does not touch the formal release backup directory.
"""
import hashlib
import os
import shutil
import sqlite3

ROOT = "/var/lib/docker/volumes/solo_to_china_data/_data"
SOURCE = f"{ROOT}/solo-to-china.sqlite"
BASELINE = f"{ROOT}/editorial-replay-20260923-baseline.sqlite"
WORK = f"{ROOT}/editorial-replay-20260923-work.sqlite"
TABLES = ("sources", "source_assets", "article_drafts", "article_visuals",
          "required_media_manifests", "jobs", "wordpress_publications")

if not os.path.isfile(SOURCE) or any(os.path.exists(p) for p in (BASELINE, WORK)):
    raise SystemExit("Source missing or replay target already exists")
if shutil.disk_usage(ROOT).free < 7 * 1024**3:
    raise SystemExit("Insufficient space for a two-copy production replay")

def audit(filename):
    db = sqlite3.connect(f"file:{filename}?mode=ro", uri=True)
    try:
        integrity = db.execute("PRAGMA quick_check").fetchone()[0]
        foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
        counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in TABLES}
        if integrity != "ok" or foreign_keys:
            raise RuntimeError(f"Replay copy corrupt: {integrity}, FK={len(foreign_keys)}")
        return counts
    finally:
        db.close()

original = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
try:
    baseline = sqlite3.connect(BASELINE)
    try:
        original.backup(baseline, pages=4096, sleep=0.05)
    finally:
        baseline.close()
finally:
    original.close()
baseline_counts = audit(BASELINE)
shutil.copyfile(BASELINE, WORK)
if audit(WORK) != baseline_counts:
    raise RuntimeError("Work-copy fingerprint differs from baseline")
print({"baseline": BASELINE, "work": WORK,
       "bytes": os.path.getsize(BASELINE), "counts": baseline_counts,
       "integrity": "ok", "foreign_keys": 0})
