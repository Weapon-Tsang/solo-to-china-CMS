"""Archive only the verified runtime manifest; retain extraction for byte review."""
import hashlib
import json
from pathlib import Path
import zipfile

evidence = Path('docs/codex-cms-upgrade/evidence/phase-04-fixes')
candidate = json.loads((evidence / 'candidate.json').read_text(encoding='utf-8'))
output = Path(candidate['output'])
archive = output / 'cms-runtime-payload.zip'
extracted = output / 'archive-verified'
files = candidate['files']
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as z:
    for item in files:
        z.write(Path(candidate['release']) / item['path'], item['path'])
with zipfile.ZipFile(archive) as z:
    assert sorted(z.namelist()) == sorted(item['path'] for item in files)
    for item in files:
        name = item['path']
        target = (extracted / name).resolve()
        assert target.is_relative_to(extracted.resolve())
        data = z.read(name)
        assert len(data) == item['bytes']
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as f:
            f.write(data)
        assert hashlib.sha256(target.read_bytes()).hexdigest() == item['sha256']
result = dict(status='PASS', archive=str(archive.resolve()),
              sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
              files=len(files), extracted=str(extracted.resolve()),
              dependencies_included=False, exact_entries_and_extracted_bytes_verified=True)
(evidence / 'archive.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
