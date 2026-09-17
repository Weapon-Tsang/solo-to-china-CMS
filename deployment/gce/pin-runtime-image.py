"""After verified rollout, update only ENGINE_IMAGE; keep credentials private."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

app = Path('/opt/solo-to-china')
release = Path(sys.argv[1]).resolve()
image = sys.argv[2]
assert release.parent == app / 'upgrades' and (release / 'complete').is_file()
assert re.fullmatch(r'asia-east1-docker\.pkg\.dev/[^\s]+@sha256:[0-9a-f]{64}', image)
actual = subprocess.check_output(['docker', 'inspect', '--format', '{{.Config.Image}}', 'engine'], text=True).strip()
assert actual == image, 'Active container does not match the verified image'
config = app / '.env.production'
before = config.read_bytes()
pattern = rb'(?m)^ENGINE_IMAGE=[^\r\n]*'
assert len(re.findall(pattern, before)) == 1, 'Expected exactly one image reference'
after = re.sub(pattern, b'ENGINE_IMAGE=' + image.encode('ascii'), before)
assert re.sub(pattern, b'', before) == re.sub(pattern, b'', after)
backup = release / '.env.production.before-image-pin'
if before != after:
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(before)
        stream.flush()
        os.fsync(stream.fileno())
    temporary = release / '.env.production.pinned.tmp'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(after)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, config)
report = {'image': image, 'otherRuntimeConfigPreserved': True,
          'environmentSha256': hashlib.sha256(config.read_bytes()).hexdigest(),
          'privatePreviousConfig': str(backup)}
(release / 'image-pin.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
