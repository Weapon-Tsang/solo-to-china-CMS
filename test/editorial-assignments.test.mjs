import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { evaluateEditorialAssignment } from "../src/editorial-assignments.mjs";
import { Repository } from "../src/repository.mjs";
import { createApplication } from "../src/server.mjs";

test("manual City Walk assignments report concrete gaps and accept evidence-bounded material", () => {
  const assignment = {
    id: "assignment-test", destinationSlug: "chongqing", title: "重庆 City Walk",
    assignmentType: "city_walk", contentType: "itinerary", brief: "半天步行路线",
    targetEntities: ["洪崖洞", "山城巷", "十八梯"], desiredVisual: "route_sketch",
  };
  const thin = evaluateEditorialAssignment({
    assignment, destinationName: "重庆",
    facts: [fact("hongyadong.route", "洪崖洞", "walking route", "从入口开始步行", "source-a")],
    sourceFamilyCount: 1,
  });
  assert.equal(thin.ready, false);
  assert.ok(thin.gaps.some((item) => item.key === "fact_count"));
  assert.ok(thin.gaps.some((item) => item.key === "source_family_count"));
  assert.match(thin.acquisitionRequests[0].message, /重庆/);
  assert.match(thin.acquisitionRequests[0].message, /洪崖洞|山城巷|十八梯/);

  const complete = evaluateEditorialAssignment({
    assignment, destinationName: "重庆", facts: completeCityWalkFacts(), sourceFamilyCount: 2,
  });
  assert.equal(complete.ready, true, JSON.stringify(complete.gaps));
  assert.equal(complete.acquisitionRequests.length, 0);
  assert.equal(complete.visualBrief.generationMode, "original_illustration");
  assert.match(complete.visualBrief.instruction, /不是导航地图/);
  assert.ok(complete.selectedFactKeys.length >= 8);
});

test("repository keeps manual assignments separate, queues only ready work, and preserves production on list deletion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-editorial-assignment-"));
  const db = openDatabase(path.join(directory, "assignment.sqlite"));
  const repository = new Repository(db);
  try {
    const timestamp = new Date().toISOString();
    db.prepare("INSERT INTO destinations(id,slug,name,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("dst-cq", "chongqing", "重庆", timestamp, timestamp);
    const insert = db.prepare(`INSERT INTO knowledge_facts(
      id,destination_id,normalized_key,subject,predicate,consensus_status,preferred_value,
      support_count,contradiction_count,evidence_json,updated_at,entity_key,canonical_subject,
      entity_type,granularity
    ) VALUES (?,?,?,?,?,'single_source',?,1,0,?,?,?,?,'attraction','specific_entity')`);
    for (const [index, item] of completeCityWalkFacts().entries()) {
      insert.run(`fact-${index}`, "dst-cq", item.normalized_key, item.subject, item.predicate, item.preferred_value,
        JSON.stringify(item.evidence), timestamp, `attraction.${index}`, item.canonical_subject);
    }
    const created = repository.createEditorialAssignment({
      destinationSlug: "chongqing", title: "重庆 City Walk：山城步行路线", assignmentType: "city_walk",
      targetEntities: ["洪崖洞", "山城巷", "十八梯"], brief: "半天完成，写清步行顺序和交通。",
      desiredVisual: "route_sketch",
    }, "tester");
    assert.equal(created.status, "ready", JSON.stringify(created.evaluation.gaps));
    assert.equal(repository.listEditorialAssignmentWorkspace().assignments.length, 1);

    const queued = repository.queueEditorialAssignment(created.id);
    assert.equal(queued.status, "queued");
    assert.match(queued.candidate_id, /^topic_/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='plan_content' AND status='queued'").get().count, 1);
    const contentPackage = repository.getTopicPackage(queued.candidate_id);
    assert.equal(contentPackage.editorial_assignment.id, created.id);
    assert.match(contentPackage.editorial_assignment.instruction, /不要求把目的地知识库中的所有事实/);
    assert.deepEqual(contentPackage.editorial_assignment.target_entities, ["洪崖洞", "山城巷", "十八梯"]);

    const deleted = repository.deleteEditorialAssignment(created.id);
    assert.equal(deleted.productionContinues, true);
    assert.equal(repository.listEditorialAssignments().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM topic_candidates").get().count, 1);
    assert.equal(repository.getTopicPackage(queued.candidate_id).editorial_assignment.id, created.id,
      "soft-deleting a queued assignment must not remove its writing instructions from production");

    db.prepare(`INSERT INTO content_opportunities(
      id,destination_slug,topic_key,strategy_version,title,readiness_score,status,created_at,updated_at
    ) VALUES ('system-topic','chongqing','chongqing:system-topic','1.7','系统发现的美食专题',55,'recommended',?,?)`).run(timestamp, timestamp);
    assert.equal(repository.listEditorialAssignmentWorkspace().systemTopics.some((item) => item.id === "system-topic"), true);
    const dismissed = repository.dismissEditorialTopic("system-topic");
    assert.equal(dismissed.productionContinues, false);
    assert.equal(repository.listEditorialAssignmentWorkspace().systemTopics.some((item) => item.id === "system-topic"), false);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("editorial assignment API requires admin authority and returns actionable material gaps", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-editorial-assignment-api-"));
  const app = createApplication(loadConfig({
    HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: path.join(directory, "api.sqlite"),
    ADMIN_TOKEN: "assignment-admin-token", MAINTENANCE_ENABLED: "false", LOG_LEVEL: "error",
  }));
  await app.start();
  t.after(async () => {
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const timestamp = new Date().toISOString();
  app.repository.db.prepare("INSERT INTO destinations(id,slug,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run("dst-cq-api", "chongqing", "重庆", timestamp, timestamp);
  app.repository.db.prepare(`INSERT INTO knowledge_facts(
    id,destination_id,normalized_key,subject,predicate,consensus_status,preferred_value,
    support_count,contradiction_count,evidence_json,updated_at,canonical_subject,entity_type,granularity
  ) VALUES ('fact-api','dst-cq-api','hongyadong.route','洪崖洞','walking route','single_source',
    '从入口开始步行',1,0,'[{"source_id":"source-a"}]',?,'洪崖洞','attraction','specific_entity')`).run(timestamp);
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const payload = JSON.stringify({ destinationSlug: "chongqing", title: "重庆 City Walk", assignmentType: "city_walk" });
  assert.equal((await fetch(`${baseUrl}/api/editorial-assignments`, {
    method: "POST", headers: { "content-type": "application/json" }, body: payload,
  })).status, 401);
  const response = await fetch(`${baseUrl}/api/editorial-assignments`, {
    method: "POST", headers: { authorization: "Bearer assignment-admin-token", "content-type": "application/json" }, body: payload,
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.status, "needs_sources");
  assert.match(created.evaluation.acquisitionRequests[0].message, /重庆/);
  const workspace = await (await fetch(`${baseUrl}/api/editorial-assignments`, {
    headers: { authorization: "Bearer assignment-admin-token" },
  })).json();
  assert.equal(workspace.assignments.length, 1);
  assert.equal(workspace.summary.needsSources, 1);
});

function completeCityWalkFacts() {
  return [
    fact("hongyadong.walking_route", "洪崖洞", "walking route order", "从解放碑方向进入", "source-a"),
    fact("hongyadong.walk_duration", "洪崖洞", "walking duration", "步行约 20 分钟", "source-a"),
    fact("shanchengxiang.metro", "山城巷", "metro station access", "从较场口站步行到达", "source-b"),
    fact("shanchengxiang.best_time", "山城巷", "best timing", "下午适合步行", "source-b"),
    fact("shibati.walking_route", "十八梯", "walking route connection", "可步行连接山城巷", "source-a"),
    fact("shibati.entry", "十八梯", "attraction entry", "开放街区入口", "source-b"),
    fact("hongyadong.transport", "洪崖洞", "public transport", "可从临江门站步行到达", "source-b"),
    fact("shibati.timing", "十八梯", "visit timing", "傍晚前适合串联步行", "source-a"),
    fact("jiefangbei.landmark", "解放碑", "attraction orientation", "市中心地标", "source-a"),
    fact("daijiaxiang.viewpoint", "戴家巷", "viewpoint location", "可看江景", "source-b"),
    fact("kuixinglou.connection", "魁星楼", "walking connection", "连接临江门一带", "source-a"),
  ];
}

function fact(key, subject, predicate, value, sourceId) {
  return {
    normalized_key: key,
    subject,
    canonical_subject: subject,
    predicate,
    preferred_value: value,
    consensus_status: "single_source",
    freshness_state: "current",
    verification_priority: "normal",
    support_count: 1,
    entity_type: "attraction",
    granularity: "specific_entity",
    evidence: [{ source_id: sourceId, quote: value }],
  };
}
