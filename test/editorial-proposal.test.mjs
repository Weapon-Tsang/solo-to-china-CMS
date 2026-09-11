import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalFingerprint,freezeProposal,groupProposals,validatePlannedEvidence} from '../src/services/editorial-proposal.mjs';
import {separateQualityResults} from '../src/services/content-recovery-policy.mjs';
const row={id:'one',destination_slug:'chongqing',title:'One day walk',content_type:'itinerary',source_id:'s1',coverage_json:JSON.stringify({publicationMode:'source_adaptation',proposal:{readerPromise:'Walk downhill for one day',evidenceBoundary:'Named stops only'},selectedFactKeys:['route']})};
test('proposal identity includes promise and boundary but not evolving evidence readiness',()=>{
  assert.equal(proposalFingerprint(row),proposalFingerprint({...row,updated_at:'later',readiness_score:100}));
  assert.notEqual(proposalFingerprint(row),proposalFingerprint({...row,title:'Four day walk'}));
  assert.notEqual(proposalFingerprint(row),proposalFingerprint({...row,coverage_json:JSON.stringify({proposal:{readerPromise:'A different promise'}})}));
  assert.equal(freezeProposal(row).proposal.evidenceBoundary,'Named stops only');
});
test('similar directions are grouped without merging independent sources or distinct promises',()=>{
  const rows=[row,{...row,id:'two',source_id:'s2'},{...row,id:'three',coverage_json:JSON.stringify({proposal:{readerPromise:'Two day trip'}})}];
  assert.equal(groupProposals(rows).length,1);assert.equal(groupProposals(rows)[0].items.length,2);assert.equal(rows.length,3);
});
test('writing gate rejects fabricated evidence, strict conflicts and empty support before drafting',()=>{
  const pkg={facts:[{normalized_key:'route'},{normalized_key:'danger',consensus_status:'conflicted'}]};
  assert.equal(validatePlannedEvidence({outline:[{heading:'Route',claim_keys:['route']}]},pkg).valid,true);
  assert.equal(validatePlannedEvidence({outline:[{heading:'Route',claim_keys:['invented']}]},pkg).valid,false);
  assert.equal(validatePlannedEvidence({outline:[{heading:'Route',claim_keys:['danger']}]},pkg).valid,false);
  assert.equal(validatePlannedEvidence({outline:[{heading:'Route',claim_keys:[]}]},pkg).valid,false);
});
test('delivery failures cannot reduce independently passed prose quality or bypass delivery',()=>{
  const review={passed:true,score:95,issues:[]};
  const split=separateQualityResults(review,[{code:'required_visual_missing',severity:'blocker'},{code:'final_page_evidence_invalid',severity:'blocker'}]);
  assert.equal(split.content_quality.passed,true);assert.equal(split.content_quality.score,95);assert.equal(split.delivery_quality.passed,false);
  assert.equal(separateQualityResults(review,[{code:'unsupported_claim',severity:'blocker'}]).content_quality.passed,false);
});
