import test from 'node:test';
import assert from 'node:assert/strict';
import {articleTimeEvidence} from '../src/services/article-time-evidence.mjs';

test('T03-11/19/30 four timestamps remain separate and upload/capture never verifies article facts',()=>{
  const input={publication:{response_json:JSON.stringify({status:'publish',date_gmt:'2026-09-01T10:00:00'})},
    revisions:[{revision:1,created_at:'2026-09-01T09:00:00Z',snapshot_json:{body_markdown:'Original'}}],
    facts:[{normalized_key:'hours',evidence:[{captured_at:'2026-09-28T10:00:00Z',verified_at:'2026-08-01T10:00:00Z'}]}]};
  const before=articleTimeEvidence(input);
  const after=articleTimeEvidence({...input,visuals:[{media_metadata:{web_derivative:{verification:'decoded_and_lineage_verified',optimized_at:'2026-09-28T10:00:00Z'}}}],
    revisions:[...input.revisions,{revision:2,created_at:'2026-09-28T10:00:00Z',snapshot_json:{body_markdown:'Original',seo_json:'changed metadata'}}]});
  assert.equal(after.published_at,before.published_at);assert.equal(after.substantive_edit_at,null);
  assert.equal(after.media_optimized_at,'2026-09-28T10:00:00.000Z');assert.equal(after.facts_verified_at,null);
  assert.deepEqual(after.per_fact,before.per_fact);
  assert.equal(after.per_fact[0].evidence_verified_at,'2026-08-01T10:00:00.000Z');
  const verified=articleTimeEvidence({...input,facts:[{normalized_key:'hours',evidence:[{verified_at:'2026-09-27T10:00:00Z'}]}]});
  assert.equal(verified.per_fact[0].evidence_verified_at,'2026-09-27T10:00:00.000Z');
  assert.equal(verified.published_at,before.published_at);assert.equal(verified.media_optimized_at,null);
  assert.equal(articleTimeEvidence({...input,revisions:[...input.revisions,{revision:2,created_at:'2026-09-27T12:00:00Z',snapshot_json:{body_markdown:'Evidence-supported change'}}]}).substantive_edit_at,'2026-09-27T12:00:00.000Z');
  assert.equal(articleTimeEvidence({publication:{response_json:{status:'draft',date_gmt:'2026-09-28T00:00:00'}}}).published_at,null);
  assert.equal(articleTimeEvidence({facts:[{normalized_key:'manual-caption',evidence:[{captured_at:'2026-09-28T00:00:00Z'}]}]}).per_fact[0].evidence_verified_at,null);
  assert.equal(articleTimeEvidence({visuals:[{media_metadata:{web_derivative:{verification:'decoded_and_lineage_verified'}}}]}).media_optimized_at,null,'old receipts do not get today injected');
});
