"""Verify and extract a streamed Stage 01 snapshot outside the Git tree."""

import os
import tarfile
from pathlib import Path
from pathlib import PurePosixPath


archive_path = Path(os.environ.get("STC_STAGE01_ARCHIVE_PATH", "")).resolve()
target = Path(os.environ.get("STC_STAGE01_BASELINE_DIR", "")).resolve()
checkout = Path(__file__).resolve().parent.parent
if archive_path.is_relative_to(checkout) or target.is_relative_to(checkout):
    raise SystemExit("Snapshot archive and extraction target must stay outside the repository.")
if not archive_path.is_file() or (target.exists() and os.environ.get("STC_STAGE01_RESUME") != "1"):
    raise SystemExit("Archive must exist and baseline directory must not exist unless resuming.")

io_target = "\\\\?\\" + str(target) if os.name == "nt" else str(target)

with tarfile.open(archive_path, "r:gz") as archive:
    members = []
    for item in archive.getmembers():
        if item.name in {".", "./"}:
            continue
        name = item.name.removeprefix("./")
        if PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
            raise SystemExit("Snapshot archive contains an unsafe path.")
        item.name = name.replace("/", os.sep)
        members.append(item)
    if not members or any(not (item.isfile() or item.isdir()) for item in members):
        raise SystemExit("Snapshot archive contains an unsupported entry.")
    archive.extractall(io_target, members=members, filter="data")

database = target / "database.sqlite"
manifest = target / "manifest.json"
if not database.is_file() or not manifest.is_file():
    raise SystemExit("Snapshot archive is missing its database or manifest.")
print(f"archive_verified=True entries={len(members)} database_bytes={database.stat().st_size}")
