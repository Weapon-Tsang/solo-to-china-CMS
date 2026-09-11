import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackup, drillBackup, verifyBackup } from "../src/backup.mjs";
import { openDatabase, SCHEMA_VERSION } from "../src/db.mjs";

test("system snapshot hashes the database, uploads and generated media and drills an offline delivery", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({
    databasePath: fixture.databasePath,
    backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir,
    generatedMediaDir: fixture.mediaDir,
    retention: 2,
    offsiteLocation: "gs://controlled-backups/solo-to-china",
    offsiteRetentionDays: 90,
    codeRevision: "engine@sha256:fixture",
    reason: "pre-upgrade",
    clock: () => new Date("2026-08-23T12:00:00.000Z"),
  });

  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.integrity, "ok");
  assert.ok(fs.statSync(result.backupPath).isDirectory());
  const verification = verifyBackup(result.backupPath);
  assert.equal(verification.sha256, result.sha256);
  assert.equal(verification.fileCount, 3);
  assert.equal(verification.referenceCount, 3);
  assert.equal(verification.manifest.reason, "pre-upgrade");
  assert.equal(verification.manifest.application.codeRevision, "engine@sha256:fixture");
  assert.equal(verification.manifest.retention.offsiteRetentionDays, 90);
  assert.equal(verification.manifest.secrets.included, false);
  assert.doesNotMatch(fs.readFileSync(result.manifestPath, "utf8"), /fixture-password/);

  const drill = drillBackup(result.backupPath);
  assert.equal(drill.drill, "passed");
  assert.equal(drill.externalSideEffects, false);
  assert.equal(drill.counts.source_files, 1);
  assert.equal(drill.counts.article_drafts, 1);
  assert.equal(drill.evidencePreviewsOpened, 2);
  assert.equal(drill.draftMediaOpened, 1);
  assert.deepEqual(drill.references.map((item) => item.opened), [true, true, true]);
  assert.deepEqual(drill.deliveryProbe, {
    status: "passed", draftId: "draft-1", state: "ready_for_wordpress", mockDeliveryCalls: 1,
    externalModelCalls: 0, externalWordPressCalls: 0, restoredMediaCount: 1,
  });
});

test("restore verification rejects a deleted database-referenced image", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({
    databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir,
    clock: () => new Date("2026-08-24T12:00:00.000Z"),
  });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  const referenced = manifest.databaseReferences.find((item) => item.table === "source_files");
  fs.rmSync(path.join(result.backupPath, ...referenced.archivePath.split("/")));
  assert.throws(() => drillBackup(result.backupPath), /Snapshot file is missing/);
});

test("snapshot verification compares manifest hashes rather than only file sizes", (t) => {
  const fixture = backupFixture(t);
  const result = createBackup({
    databasePath: fixture.databasePath, backupDir: fixture.backupDir,
    sourceUploadsDir: fixture.uploadsDir, generatedMediaDir: fixture.mediaDir,
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
  });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  const media = manifest.files.find((item) => item.category === "generated_media");
  const filename = path.join(result.backupPath, ...media.archivePath.split("/"));
  const bytes = fs.readFileSync(filename);
  bytes[0] ^= 0xff;
  fs.writeFileSync(filename, bytes);
  assert.throws(() => verifyBackup(result.backupPath), /Snapshot hash mismatch/);
});

function backupFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solo-to-china-backup-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "source.sqlite");
  const uploadsDir = path.join(directory, "source-uploads");
  const mediaDir = path.join(directory, "generated-media");
  const backupDir = path.join(directory, "backups");
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const evidencePath = path.join(uploadsDir, "route.jpg");
  const mediaPath = path.join(mediaDir, "draft-hero.png");
  fs.writeFileSync(evidencePath, Buffer.from("recoverable source image"));
  fs.writeFileSync(mediaPath, Buffer.from("recoverable generated image"));

  const database = openDatabase(databasePath);
  database.prepare(`INSERT INTO sources(id,adapter,canonical_url,captured_at,raw_text,raw_html,raw_payload_json,content_hash,created_at,updated_at)
    VALUES ('source-1','manual','manual-source://source-1','now','Evidence','','{}','hash','now','now')`).run();
  database.prepare(`INSERT INTO source_files(id,source_id,file_kind,original_filename,mime_type,storage_path,size_bytes,sha256,created_at)
    VALUES ('file-1','source-1','image','route.jpg','image/jpeg',?,?,?,'now')`)
    .run(evidencePath, fs.statSync(evidencePath).size, sha256(evidencePath));
  database.prepare(`INSERT INTO source_assets(id,source_id,kind,remote_url,position,local_path,mime_type,original_filename)
    VALUES ('asset-1','source-1','image','manual-asset://source-1/0',0,?,'image/jpeg','route.jpg')`).run(evidencePath);
  database.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,created_at,updated_at)
    VALUES ('brief-1','beijing','Test route','solo travelers','informational','now','now')`).run();
  database.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at)
    VALUES ('draft-1','brief-1','Recovered Beijing Route','recovered-beijing-route','## Route\n\nRecovered body.','{}','qa_queued','now','now')`).run();
  database.prepare(`INSERT INTO article_visuals(id,draft_id,slot,placement,purpose,alt_text,generation_prompt,status,media_path,created_at,updated_at)
    VALUES ('visual-1','draft-1',1,'hero','Orient the reader','Beijing route','','generated',?,'now','now')`).run(mediaPath);
  database.close();
  return { directory, databasePath, uploadsDir, mediaDir, backupDir };
}

function sha256(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
