"""Read-only aggregate audit of an extracted production snapshot.

The input directory and all output remain local. No row text, IDs, or media
bytes are emitted, so the JSON result can be stored as stage evidence.
"""

import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path


if len(sys.argv) != 2:
    raise SystemExit("Usage: python scripts/stage01-audit-snapshot.py <extracted-snapshot>")
root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
db = sqlite3.connect(f"file:{root / 'database.sqlite'}?mode=ro", uri=True)
db.execute("PRAGMA query_only=ON")
count = lambda sql: int(db.execute(sql).fetchone()[0])
archived = {item["archivePath"] for item in manifest["files"]}
originals = {item.get("originalPath", "").replace("\\", "/") for item in manifest["files"]}
references = {}
for column in ["original_storage_ref", "derivative_storage_ref"]:
    rows = db.execute(f"SELECT {column} FROM source_asset_storage_refs WHERE COALESCE({column},'')<>''")
    status = Counter("present" if f"files/source-uploads/{value}" in archived else "missing" for (value,) in rows)
    references[column] = dict(status)
rows = db.execute("SELECT media_path FROM visual_candidates WHERE COALESCE(media_path,'')<>''")
references["visual_candidates.media_path"] = dict(Counter(
    "present" if value.replace("\\", "/") in originals else "missing" for (value,) in rows
))
out = {
    "version": "stage01-production-snapshot-audit-1",
    "readOnly": True,
    "snapshotManifestVersion": manifest["version"],
    "quickCheck": db.execute("PRAGMA quick_check").fetchone()[0],
    "schemaVersion": count("SELECT MAX(version) FROM schema_migrations"),
    "counts": {table: count(f"SELECT COUNT(*) FROM {table}") for table in [
        "sources", "jobs", "claims", "knowledge_facts", "content_opportunities",
        "article_drafts", "source_assets", "vertex_batch_runs",
    ]},
    "sourceStatuses": dict(db.execute("SELECT status,COUNT(*) FROM sources GROUP BY status")),
    "jobStatuses": dict(db.execute("SELECT status,COUNT(*) FROM jobs GROUP BY status")),
    "processingSourcesWithoutActiveSourceJob": count("""
        SELECT COUNT(*) FROM sources s WHERE s.status='processing'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.entity_id=s.id AND j.status IN ('queued','running'))
    """),
    "orphanParentJobs": count("""
        SELECT COUNT(*) FROM jobs j WHERE COALESCE(j.parent_job_id,'')<>''
        AND NOT EXISTS (SELECT 1 FROM jobs parent WHERE parent.id=j.parent_job_id)
    """),
    "productionJobsMissingOwner": count("""
        SELECT COUNT(*) FROM jobs j WHERE COALESCE(j.production_attempt_id,'')<>''
        AND COALESCE(j.production_owner_opportunity_id,'')=''
    """),
    "failedJobsWithoutFailureClass": count("""
        SELECT COUNT(*) FROM jobs WHERE status='failed' AND COALESCE(failure_class,'')=''
    """),
    "batchStatuses": dict(db.execute("SELECT status,COUNT(*) FROM vertex_batch_runs GROUP BY status")),
    "unresolvedMediaDispatches": count("""
        SELECT COUNT(*) FROM media_dispatches WHERE state IN ('dispatch_started','outcome_unknown')
    """),
    "unresolvedMediaDispatchSubstages": dict(db.execute("""
        SELECT substage,COUNT(*) FROM media_dispatches
        WHERE state IN ('dispatch_started','outcome_unknown') GROUP BY substage
    """)),
    "archivedReferenceCoverage": references,
}
db.close()
print(json.dumps(out, ensure_ascii=False, indent=2))
