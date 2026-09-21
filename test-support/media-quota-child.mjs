import { openDatabase } from '../src/db.mjs';
import { createMediaRequestExecutor } from '../src/media-request-executor.mjs';

const db = openDatabase(process.env.TEST_DATABASE_PATH, { migrate:false });
const executor = createMediaRequestExecutor(db, { rpm:1000, windowMs:60_000, safetyMarginMs:0 });
let permit;
try {
  permit = executor.acquire({provider:'vertex_gemini',model:'image-test',accountScope:'two-process-test',
    visualId:process.env.TEST_VISUAL_ID,substage:'generate_visual'});
  process.stdout.write('ACQUIRED\n');
} catch(error) {
  process.stdout.write(`${error.code || 'ERROR'}\n`);
  db.close();
  process.exit(0);
}
process.stdin.setEncoding('utf8');
process.stdin.once('data', () => {
  permit.finish();
  db.close();
  process.exit(0);
});
