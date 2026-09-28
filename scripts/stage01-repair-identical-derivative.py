"""Create a separate Stage 01 snapshot copy for a proven identical-byte alias.

This is intentionally narrow. The source manifest and database are read only.
It refuses any derivative whose five references do not all identify one archived,
hash-verified original with the same stored derivative digest.
"""

import argparse
import hashlib
import json
import shutil
import sqlite3
from pathlib import Path


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    target = args.target.resolve()
    if target.exists() or target == source or source in target.parents:
        raise SystemExit("Target must be a new directory outside the original snapshot.")
    manifest_path = source / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != 2:
        raise SystemExit("This rehearsal accepts only the examined v2 format.")
    archived = {entry["archivePath"]: entry for entry in manifest["files"]}
    db = sqlite3.connect(f"file:{(source / 'database.sqlite').as_posix()}?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    rows = db.execute("""SELECT sr.asset_id,sr.original_storage_ref,sr.derivative_storage_ref,
        sr.transform_json,sa.ai_derivative_sha256,sa.original_sha256,sa.stored_sha256,
        sa.original_bytes_status
        FROM source_asset_storage_refs sr JOIN source_assets sa ON sa.id=sr.asset_id
        WHERE sr.derivative_storage_ref<>''""").fetchall()
    missing = [row for row in rows if f"files/source-uploads/{row[2]}" not in archived]
    if len(missing) != 5 or len({row[2] for row in missing}) != 1:
        raise SystemExit("Expected exactly five references to one missing derivative.")
    derivative_ref = missing[0][2]
    expected_hash = Path(derivative_ref).stem
    if len(expected_hash) != 64:
        raise SystemExit("Derivative path has no SHA-256 basename.")
    parents = {row[1] for row in missing}
    if len(parents) != 1:
        raise SystemExit("Derivative references do not share one original.")
    original_ref = next(iter(parents))
    original_archive = f"files/source-uploads/{original_ref}"
    derivative_archive = f"files/source-uploads/{derivative_ref}"
    original_entry = archived.get(original_archive)
    if not original_entry or original_entry["sha256"] != expected_hash:
        raise SystemExit("The original manifest does not prove the requested bytes.")
    if any(row[4] != expected_hash or row[5] != expected_hash or row[6] != expected_hash
           or row[7] != "saved_original" or row[3] != "{}" for row in missing):
        raise SystemExit("Derivative and original database receipts differ.")
    original_file = source / original_archive
    if not original_file.is_file() or digest(original_file) != expected_hash:
        raise SystemExit("Archived original bytes do not match the expected digest.")
    if original_file.stat().st_size != original_entry["bytes"]:
        raise SystemExit("Archived original size differs from the manifest.")
    db.close()

    # Windows Store redirects LocalAppData into a deep package directory. The
    # extended path prefix lets shutil copy valid files whose absolute paths
    # exceed the legacy MAX_PATH limit.
    source_io = Path("\\\\?\\" + str(source)) if source.drive else source
    target_io = Path("\\\\?\\" + str(target)) if target.drive else target
    shutil.copytree(source_io, target_io)
    target_derivative = target_io / derivative_archive
    target_derivative.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(target_io / original_archive, target_derivative)
    if digest(target_derivative) != expected_hash:
        raise SystemExit("Copied derivative bytes failed final verification.")
    manifest["files"].append({
        "category": original_entry["category"],
        "archivePath": derivative_archive,
        "originalPath": str(Path(original_entry["originalPath"]).parents[2] / derivative_ref).replace("\\", "/"),
        "bytes": original_entry["bytes"],
        "sha256": expected_hash,
    })
    manifest["totals"]["files"] = len(manifest["files"])
    manifest["totals"]["bytes"] += original_entry["bytes"]
    manifest["localRepair"] = {
        "id": "stage01-identical-byte-alias-20260927",
        "parentManifestSha256": digest(manifest_path),
        "addedArchivePath": derivative_archive,
        "copiedFromArchivePath": original_archive,
        "reason": "Five derivative references have the same verified SHA-256 as the archived original.",
    }
    (target_io / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"target": str(target), "parentManifestSha256": digest(manifest_path),
                      "newManifestSha256": digest(target_io / "manifest.json"), "referenceCount": len(missing),
                      "addedFileSha256": expected_hash, "addedFileBytes": original_entry["bytes"]}))


if __name__ == "__main__":
    main()
