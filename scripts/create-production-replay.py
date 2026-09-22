"""Create an immutable online SQLite baseline and disposable work copy.

The target files must not exist; this script never modifies the live database.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path


if len(sys.argv) != 4:
    raise SystemExit('usage: create-production-replay.py LIVE BASELINE WORK')
live, baseline, work = (Path(value).resolve() for value in sys.argv[1:])
if len({live, baseline, work}) != 3 or not live.is_file():
    raise SystemExit('live, baseline, and work must be distinct; live must exist')
if baseline.exists() or work.exists():
    raise SystemExit('baseline and work targets must not already exist')
if 'baseline' not in baseline.name or 'work' not in work.name:
    raise SystemExit('target filenames must explicitly contain baseline and work')
baseline.parent.mkdir(parents=True, exist_ok=True)
work.parent.mkdir(parents=True, exist_ok=True)

source = sqlite3.connect(f'file:{live}?mode=ro', uri=True)
target = sqlite3.connect(str(baseline))
try:
    source.backup(target, pages=1000, sleep=0.1)
finally:
    target.close()
    source.close()

def check(filename):
    connection = sqlite3.connect(f'file:{filename}?mode=ro', uri=True)
    try:
        integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
        foreign_keys = connection.execute('PRAGMA foreign_key_check').fetchall()
        counts = {table: connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                  for table in ('sources', 'source_assets', 'article_drafts',
                                'article_visuals', 'jobs', 'wordpress_publications')}
        if integrity != 'ok' or foreign_keys:
            raise RuntimeError(f'{filename}: integrity={integrity}, foreign key errors={len(foreign_keys)}')
        return counts
    finally:
        connection.close()

baseline_counts = check(baseline)
shutil.copy2(baseline, work)
work_counts = check(work)
if baseline_counts != work_counts:
    raise RuntimeError('baseline/work row counts differ')

def digest(filename):
    hash_value = hashlib.sha256()
    with filename.open('rb') as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            hash_value.update(block)
    return hash_value.hexdigest()

baseline_hash = digest(baseline)
work_hash = digest(work)
if baseline_hash != work_hash:
    raise RuntimeError('baseline/work SHA-256 mismatch')
os.chmod(baseline, 0o444)
print(json.dumps({'live': str(live), 'baseline': str(baseline), 'work': str(work),
                  'sha256': baseline_hash, 'counts': baseline_counts,
                  'integrity': 'ok', 'foreign_keys': 0}))
