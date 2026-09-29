import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {evidenceFamilyKeys,usableOpportunityFact,completedOpportunitySourceIds,selectedFamilyProjection} from '../src/opportunity-family-evidence.mjs';

test('independent hand-authored family sets cover duplicates, ungrouped sources and membership changes',()=>{
  const evidence=[{source_id:'a'},{source_id:'b'},{source_id:'a'},{source_id:'c'},{source_id:null},{}];
  const families=new Map([['a','shared'],['b','shared'],['c',null]]);
  assert.deepEqual(evidenceFamilyKeys(evidence,families),['family:shared','source:c']);
  families.set('b','split');
  assert.deepEqual(evidenceFamilyKeys(evidence,families),['family:shared','family:split','source:c']);
  families.set('c','shared');
  assert.deepEqual(evidenceFamilyKeys(evidence,families),['family:shared','family:split']);
});

test('historical, hidden, conflicted and valueless facts cannot contribute selected families',()=>{
  const good={visibility_status:'visible',validity_state:'current',consensus_status:'single_source',preferred_value:'free'};
  assert.equal(usableOpportunityFact(good),true);
  assert.equal(usableOpportunityFact({...good,validity_state:'unknown'}),true);
  for(const delta of [{validity_state:'historical'},{visibility_status:'hidden'},{consensus_status:'conflicted'},{preferred_value:'  '}])
    assert.equal(usableOpportunityFact({...good,...delta}),false);
});

test('current capture eligibility and individual membership changes are independently fingerprinted',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE sources(id TEXT,status TEXT,completeness_status TEXT,capture_version INTEGER);
      CREATE TABLE current_source_assets(source_id TEXT,durability_status TEXT);
      CREATE TABLE experience_extraction_runs(source_id TEXT,capture_version INTEGER,status TEXT,degraded INTEGER);
      CREATE TABLE source_family_memberships(source_id TEXT,family_id TEXT);
      CREATE TABLE destinations(id TEXT,slug TEXT);
      CREATE TABLE knowledge_facts(id TEXT,destination_id TEXT,normalized_key TEXT,consensus_status TEXT,preferred_value TEXT,visibility_status TEXT,validity_state TEXT,evidence_json TEXT);
      CREATE TABLE knowledge_resolutions(destination_slug TEXT,normalized_key TEXT,status TEXT,preferred_value TEXT);
      INSERT INTO sources VALUES ('a','processed','complete',2),('b','processed','complete',2),('old','processed','complete',2);
      INSERT INTO experience_extraction_runs VALUES ('a',2,'succeeded',0),('b',2,'succeeded',0),('old',1,'succeeded',0);
      INSERT INTO source_family_memberships VALUES ('a','one'),('b','two');
      INSERT INTO destinations VALUES ('d','city');
      INSERT INTO knowledge_facts VALUES ('f','d','key','single_source','value','visible','current','[{"source_id":"a"},{"source_id":"b"}]');`);
    assert.deepEqual([...completedOpportunitySourceIds(db)].sort(),['a','b']);
    const opportunity={destination_slug:'city',coverage_json:'{"selectedFactKeys":["key"]}'};
    const before=selectedFamilyProjection(db,opportunity);
    db.exec("UPDATE source_family_memberships SET family_id=CASE source_id WHEN 'a' THEN 'two' ELSE 'one' END");
    const after=selectedFamilyProjection(db,opportunity);
    assert.deepEqual(after.families,before.families);
    assert.notEqual(after.dependencyFingerprint,before.dependencyFingerprint);
    db.exec("INSERT INTO current_source_assets VALUES ('a',NULL)");
    assert.deepEqual([...completedOpportunitySourceIds(db)],['b']);
  } finally {db.close();}
});
