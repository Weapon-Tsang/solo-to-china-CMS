import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';

const databasePath = path.resolve(process.argv[2] || '');
if (!databasePath || !process.argv[2]) throw new Error('Pass an explicit database path.');
const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec('PRAGMA query_only=ON');
try {
  const repository = new Repository(db);
  const rows = repository.listContent({ productionOnly: true });
  console.log(JSON.stringify(rows.map((row) => ({
    opportunity_id: row.opportunity_id,
    title: row.title,
    draft_id: row.draft_id,
    draft_status: row.draft_status,
    stage_status: row.production_state?.stage_status,
    current_stage: row.production_state?.current_stage,
    recovery_target: row.production_state?.recovery_target,
    latest_error: row.production_state?.latest_error,
  })), null, 2));
} finally {
  db.close();
}
