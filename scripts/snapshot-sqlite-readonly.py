"""Take a consistent SQLite snapshot without opening the live source for writing."""

import hashlib
import os
import sqlite3
import sys
import time

if len(sys.argv) != 3:
    raise SystemExit("usage: snapshot-sqlite-readonly.py SOURCE DESTINATION")

source, destination = sys.argv[1:]
if os.path.exists(destination):
    raise SystemExit("destination already exists")

started = time.monotonic()
reader = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=30)
writer = sqlite3.connect(destination)
try:
    reader.backup(writer, pages=1000, sleep=0.1)
    result = writer.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise RuntimeError(f"snapshot integrity check failed: {result}")
finally:
    writer.close()
    reader.close()

digest = hashlib.sha256()
with open(destination, "rb") as snapshot:
    while chunk := snapshot.read(8 * 1024 * 1024):
        digest.update(chunk)
print({"bytes": os.path.getsize(destination), "sha256": digest.hexdigest(),
       "seconds": round(time.monotonic() - started, 2), "integrity": "ok"})
