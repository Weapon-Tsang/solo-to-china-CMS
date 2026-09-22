"""Guarded, consistent SQLite backup and restore drill before strategy-field repair."""
import hashlib
import os
import shutil
import sqlite3

ROOT = "/var/lib/docker/volumes/solo_to_china_data/_data"
LIVE = f"{ROOT}/solo-to-china.sqlite"
BASELINE = f"{ROOT}/backups/strategy-repair-20260922-baseline.sqlite"
DRILL = f"{ROOT}/backups/strategy-repair-20260922-drill.sqlite"
TABLES = ("article_drafts", "quality_reviews", "article_photo_refreshes", "jobs", "model_call_metrics")

if not os.path.isfile(LIVE) or os.path.exists(BASELINE) or os.path.exists(DRILL):
    raise SystemExit("Live database missing, or immutable backup/drill target already exists")
usage = shutil.disk_usage(ROOT)
if usage.free < 6 * 1024**3:
    raise SystemExit(f"Insufficient free space for backup and restore drill: {usage.free}")

def fingerprint(db):
    return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in TABLES}

def verify(db):
    integrity = db.execute("PRAGMA quick_check").fetchone()[0]
    foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
    if integrity != "ok" or foreign_keys:
        raise RuntimeError(f"Integrity failure: {integrity}; foreign-key failures: {len(foreign_keys)}")
    return fingerprint(db)

def sha256(filename):
    digest = hashlib.sha256()
    with open(filename, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

source = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
try:
    live_counts = fingerprint(source)
    destination = sqlite3.connect(BASELINE)
    try:
        source.backup(destination)
    finally:
        destination.close()
finally:
    source.close()

baseline = sqlite3.connect(f"file:{BASELINE}?mode=ro", uri=True)
try:
    backup_counts = verify(baseline)
finally:
    baseline.close()
if backup_counts != live_counts:
    raise RuntimeError("Backup table-count fingerprint differs from live source")

shutil.copyfile(BASELINE, DRILL)
restored = sqlite3.connect(f"file:{DRILL}?mode=ro", uri=True)
try:
    drill_counts = verify(restored)
finally:
    restored.close()
if drill_counts != backup_counts or sha256(DRILL) != sha256(BASELINE):
    raise RuntimeError("Restore drill fingerprint or bytes differ from baseline")
os.unlink(DRILL)
os.chmod(BASELINE, 0o444)
print({"backup": BASELINE, "size": os.path.getsize(BASELINE),
       "sha256": sha256(BASELINE), "counts": backup_counts,
       "integrity": "ok", "foreign_keys": 0, "restore_drill": "passed"})
