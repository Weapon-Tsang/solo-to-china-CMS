"""Verify and archive a credential-free cloud extension load directory."""
import hashlib
import json
from pathlib import Path
import zipfile

source = Path('output/phase04-cloud-extension-2.0.71')
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['version'] == '2.0.71'
assert 'https://capture.solotochina.com/*' in manifest['host_permissions']
background = (source / 'background.js').read_text(encoding='utf-8')
assert 'const DEFAULT_ENDPOINT = "https://capture.solotochina.com";' in background
assert 'const DEFAULT_CAPTURE_TOKEN = "";' in background
archive = source.parent / (source.name + '.zip')
files = sorted(p for p in source.rglob('*') if p.is_file())
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
    for filename in files:
        bundle.write(filename, filename.relative_to(source).as_posix())
with zipfile.ZipFile(archive) as bundle:
    for filename in files:
        relative = filename.relative_to(source).as_posix()
        assert hashlib.sha256(bundle.read(relative)).digest() == hashlib.sha256(filename.read_bytes()).digest()
print(json.dumps({
    'path': str(archive.resolve()),
    'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'files': len(files), 'version': manifest['version'],
    'token_embedded': False, 'endpoint': 'https://capture.solotochina.com',
}))
