import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

test('article media checkpoints decode only selected Knowledge at production scale', t => {
  const {db,repository}=repositoryFixture(t);
  db.prepare("INSERT INTO destinations(id,slug,name,created_at,updated_at) VALUES ('city','city','City','now','now')").run();
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,
    evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('topic','city','city:museum','Museum guide','test',100,1,0,'candidate','now','now')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,
    readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('owner','city','city:museum','3.9','topic','Museum guide',100,'{}',
    '{"selectedFactKeys":["museum.hours"]}','approved_ready','now','now','now','approved')`).run();
  const insert=db.prepare(`INSERT INTO knowledge_facts(id,destination_id,normalized_key,subject,predicate,
    consensus_status,preferred_value,support_count,contradiction_count,evidence_json,updated_at)
    VALUES (?,'city',?,'Museum','opening_hours','single_source','09:00',1,0,'[]','now')`);
  db.exec('BEGIN');
  for(let index=0;index<5500;index++) insert.run(`fact-${index}`,index===0?'museum.hours':`unrelated.${index}`);
  db.exec('COMMIT');
  const reads=[];
  const read=repository.knowledgeForDestination.bind(repository);
  repository.knowledgeForDestination=(...args)=>{const facts=read(...args);reads.push(facts.length);return facts;};
  assert.deepEqual(repository.topicFacts('topic').map(f=>f.normalized_key),['museum.hours']);
  assert.deepEqual(repository.getTopicPackage('topic').facts.map(f=>f.normalized_key),['museum.hours']);
  repository.authorizedSourceAssetsForBrief({destination_slug:'city',topic:'Museum',evidence_ledger_json:'["museum.hours"]'});
  assert.equal(reads.length,3);
  assert.ok(reads.every(n=>n===1),`article reads decoded unrelated destination facts: ${reads}`);
});

test("production-scale Knowledge reads stay bounded and use directory/review indexes", (t) => {
  const { db,repository } = repositoryFixture(t);
  db.prepare("INSERT INTO destinations(id,slug,name,created_at,updated_at) VALUES ('city','city','Test City','2026-09-12','2026-09-12')").run();
  const insert = db.prepare(`INSERT INTO knowledge_facts(id,destination_id,normalized_key,subject,predicate,consensus_status,
    preferred_value,support_count,contradiction_count,evidence_json,updated_at,canonical_subject,entity_key)
    VALUES (?,'city',?,?,?,?,?,?,?,?,'2026-09-12',?,?)`);
  db.exec("BEGIN");
  for (let index=0;index<5_500;index+=1) {
    const subject=`Place ${index % 300}`;
    insert.run(`fact-${index}`,`place.${index % 300}.field.${index}`,subject,index % 4 === 0 ? "nearest_metro_exit" : "visitor_tip",
      index % 211 === 0 ? "conflicted" : index % 3 === 0 ? "corroborated" : "single_source",`Value ${index}`,1,index % 211 === 0 ? 1 : 0,
      JSON.stringify([{source_id:`source-${index % 74}`,value:`Value ${index}`}]),subject,`place.${index % 300}`);
  }
  db.exec("COMMIT");
  const started=performance.now();
  const summary=repository.knowledgeSummary();
  const subjects=repository.listKnowledgeSubjects({limit:50});
  const facts=repository.listKnowledgeFacts({subjectKey:subjects.items[0].subject_key,limit:50});
  const elapsed=performance.now()-started;
  assert.equal(summary.totals.facts,5_500);
  assert.equal(subjects.items.length,50);
  assert.ok(facts.items.length<=50);
  assert.ok(Buffer.byteLength(JSON.stringify({summary,subjects,facts}))<250_000);
  assert.ok(elapsed<1_500,`bounded Knowledge reads took ${Math.round(elapsed)}ms`);
  const directoryPlan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM knowledge_facts WHERE destination_id=? AND visibility_status='visible' ORDER BY canonical_subject LIMIT 50").all("city");
  const reviewPlan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM knowledge_facts WHERE consensus_status='conflicted' AND visibility_status='visible' ORDER BY updated_at DESC LIMIT 50").all();
  assert.match(directoryPlan.map((row)=>row.detail).join(" "),/idx_knowledge_facts_directory/);
  assert.match(reviewPlan.map((row)=>row.detail).join(" "),/idx_knowledge_facts_review/);
});
