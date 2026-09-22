"""Plan then remove only named, obsolete SQLite rehearsal copies.

Formal .snapshot directories, pre-import safeguards, the live database, and the
current editorial replay are deliberately outside this allowlist.
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path('/var/lib/docker/volumes/solo_to_china_data/_data/backups').resolve(strict=True)
SNAPSHOT = ROOT / 'solo-to-china-2026-09-22T16-56-21-224Z.snapshot' / 'manifest.json'
if not SNAPSHOT.is_file():
    raise SystemExit('Current formal snapshot manifest is missing; refusing cleanup.')

STEMS = (
    'editorial-chain-20260922-baseline.sqlite',
    'editorial-chain-20260922-work.sqlite',
    'editorial-media-20260922-baseline.sqlite',
    'editorial-media-20260922-work.sqlite',
    'editorial-media-20260922-refresh-baseline.sqlite',
    'editorial-media-20260922-refresh-work.sqlite',
    'strategy-repair-20260922-baseline.sqlite',
    'strategy-repair-20260922-drill.sqlite',
    'visual-receipts-2.0.55-rehearsal.sqlite',
    'deploy-audit-f9b230a-baseline.sqlite',
)

entries = []
for stem in STEMS:
    for suffix in ('', '-shm', '-wal'):
        path = ROOT / f'{stem}{suffix}'
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file() or path.resolve(strict=True).parent != ROOT:
            raise SystemExit(f'Unsafe cleanup target: {path}')
        stat = path.stat()
        entries.append({'name': path.name, 'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns})

fingerprint = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
print(json.dumps({'root': str(ROOT), 'count': len(entries),
                  'total_bytes': sum(item['bytes'] for item in entries),
                  'fingerprint': fingerprint, 'files': entries}, indent=2))
if len(sys.argv) > 1:
    if len(sys.argv) != 3 or sys.argv[1] != '--apply' or sys.argv[2] != fingerprint:
        raise SystemExit('Exact --apply FINGERPRINT confirmation is required.')
    for item in entries:
        (ROOT / item['name']).unlink()
    print(f"REMOVED count={len(entries)} bytes={sum(item['bytes'] for item in entries)}")
