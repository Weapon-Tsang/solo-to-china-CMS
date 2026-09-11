import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { repositoryFixture } from "../test-support/repository-fixture.mjs";

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
