"""Read-only identity comparison for two production SQLite baselines."""

import json
import sqlite3
import sys

if len(sys.argv) != 3:
    raise SystemExit('usage: compare-production-baselines.py OLD NEW')

columns = {
    'sources': 'id,title,status,created_at,updated_at',
    'source_assets': 'id,source_id',
    'jobs': 'id,type,entity_id,status,last_error,created_at,updated_at',
    'article_drafts': 'id,title,status,updated_at',
}

def ids(filename, table):
    db = sqlite3.connect(f'file:{filename}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(f'SELECT {columns[table]} FROM {table}').fetchall()
        return {row['id']: dict(row) for row in rows}
    finally:
        db.close()

result = {}
for table in ('sources', 'source_assets', 'jobs', 'article_drafts'):
    old, new = ids(sys.argv[1], table), ids(sys.argv[2], table)
    removed = [old[key] for key in old.keys() - new.keys()]
    added = [new[key] for key in new.keys() - old.keys()]
    changed = [key for key in old.keys() & new.keys() if old[key] != new[key]]
    sample = lambda row: {key: row.get(key) for key in
        ('id', 'title', 'type', 'entity_id', 'status', 'last_error', 'source_id', 'created_at', 'updated_at')
        if key in row}
    result[table] = {'old_count': len(old), 'new_count': len(new),
                     'removed': [sample(row) for row in removed[:10]],
                     'added': [sample(row) for row in added[:10]],
                     'changed_count': len(changed), 'changed_ids': changed[:10]}
print(json.dumps(result, indent=2, ensure_ascii=False))
