// Read-only current-revision media gate diagnostics for selected production drafts.
import { DatabaseSync } from 'node:sqlite';
import { evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';

const [databasePath,...draftIds] = process.argv.slice(2);
if (!databasePath || !draftIds.length) throw new Error('usage: audit-editorial-eligibility.mjs DB DRAFT_ID...');
const db = new DatabaseSync(databasePath,{readOnly:true});
db.exec('PRAGMA query_only=ON');
try {
  console.log(JSON.stringify(draftIds.map((draftId)=>({draftId,
    eligibility:evaluatePublicationEligibility(db,draftId)})),null,2));
} finally { db.close(); }
