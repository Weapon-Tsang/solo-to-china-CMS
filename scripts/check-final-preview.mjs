// Operator-only preview-ticket smoke. Keep URLs private; they grant scoped access.
import { loadConfig } from '../src/config.mjs';

const ids = process.argv.slice(2);
if (!ids.length) throw new Error('Pass draft IDs.');
const { adminToken } = loadConfig();
if (!adminToken) throw new Error('Admin token is not configured.');
for (const id of ids) {
  const response = await fetch(`http://127.0.0.1:8080/api/drafts/${encodeURIComponent(id)}/final-preview`,{
    method:'POST',headers:{authorization:`Bearer ${adminToken}`},
  });
  const body = await response.json().catch(()=>({}));
  console.log(JSON.stringify({draftId:id,httpStatus:response.status,mode:body.mode || null,
    code:body.code || null,hasScopedUrl:Boolean(body.url),expiresAt:body.expiresAt || null,
    message:body.message || null}));
}
