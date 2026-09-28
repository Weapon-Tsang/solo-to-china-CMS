import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { routeFixture } from '../test-support/route-fixture.mjs';
import { routeContentKind, normalizeRouteFragments, compileRouteBundle, assertFrozenRoute, compareRouteMedia,
  routeSemantics, routeReadableMarkdown, validateRouteDraft } from '../src/route-bundle.mjs';
import { renderRouteSchematic, routeRenderInput, verifyRouteRender } from '../src/visuals/route-schematic.mjs';
import { openDatabase } from '../src/db.mjs';
import { persistRouteBundle, saveRouteArtifact } from '../src/repositories/route-bundles.mjs';
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.mjs';

test('route classification, explicit locators and repeated entity occurrences are independent of photo/OCR order',()=>{
  assert.equal(routeContentKind({approved_proposal:{content_type:'itinerary'}}),'route');
  assert.equal(routeContentKind({approved_proposal:{content_type:'guide',route_scope:{}}}),'mixed');
  assert.equal(routeContentKind({approved_proposal:{title:'Museum information'}}),'knowledge');
  const {input,fragment,bundle}=routeFixture();
  assert.equal(bundle.status,'FROZEN');
  assert.equal(bundle.stops.length,3);assert.equal(bundle.stops[0].entity_id,bundle.stops[2].entity_id);
  assert.notEqual(bundle.stops[0].stop_id,bundle.stops[2].stop_id);
  assert.equal(bundle.legs[1].duration,null);
  assert.equal(bundle.reality_verification,'NOT_VERIFIED');
  fragment.legs[0].evidence_span_ids=['invented'];
  assert.throws(()=>normalizeRouteFragments([fragment],input),{code:'ROUTE_EVIDENCE_PENDING'});
});

test('critical evidence and required media are separate gates; ordinary missing stop photos do not block',()=>{
  const {options,bundle}=routeFixture();assertFrozenRoute(bundle);
  const missing=structuredClone(options);missing.fragments[0].legs.pop();
  assert.equal(compileRouteBundle(missing).status,'ROUTE_EVIDENCE_PENDING');
  const conflict=structuredClone(options);conflict.fragments[0].legs[0].uncertainty='inferred';
  assert.equal(compileRouteBundle(conflict).status,'ROUTE_CONFLICT');
  assert.equal(compileRouteBundle({...options,mediaObligations:[{required:true,slot_id:'entrance',use:'precise_entrance',entity_id:'east'}]}).status,'REQUIRED_ROUTE_MEDIA_MISSING');
  assert.equal(compileRouteBundle({...options,mediaObligations:[{required:false,slot_id:'optional-map'}]}).status,'FROZEN');
});

test('same-entity other-day photos differ from whole-day route diagrams; wrong arrows and partial matches rejected',()=>{
  const {bundle}=routeFixture();
  const photo=compareRouteMedia(bundle,{use:'stop_photo',entity_id:'east',binding_valid:true,source_day:'Day 2'});
  assert.equal(photo.compatible,true);
  assert.equal(compareRouteMedia(bundle,{use:'stop_photo',entity_id:'east',binding_valid:true,conflicting_labels:['Day 2 itinerary']}).compatible,false);
  const original=routeSemantics(bundle);
  assert.equal(compareRouteMedia(bundle,{use:'route_overview',route:original}).transform,'faithful_localization');
  const bad=structuredClone(original);bad.legs[0].to_stop_id=bad.stops[2].stop_id;
  const diff=compareRouteMedia(bundle,{use:'route_overview',route:bad});
  assert.equal(diff.compatible,false);assert.equal(diff.transform,'recomposition');
  assert.notEqual(diff.source_route_hash,diff.target_route_hash);
  assert.deepEqual(routeSemantics(bundle),original);
});

test('self-reported route hash cannot hide changed Day/order/mode or mutated bundle',()=>{
  const {bundle}=routeFixture();const body=routeReadableMarkdown(bundle);
  validateRouteDraft(bundle,{body_markdown:body});
  for(const bad of [body.replace('Day 1','Day 2'),body.replace('walk','taxi'),body.replace('about 15','15'),body.replace('| East Hall |','| West Hall |')])
    assert.throws(()=>validateRouteDraft(bundle,{body_markdown:bad,approved_route_hash:bundle.approved_route_hash}),{code:'ROUTE_TEXT_MISMATCH'});
  const forged=structuredClone(bundle);forged.stops.reverse();
  assert.throws(()=>assertFrozenRoute(forged),{code:'ROUTE_VERSION_STALE'});
});

test('T03-38 similar Huangjueya and Huangjueping labels cannot substitute for the approved entity occurrence',()=>{
  const {options}=routeFixture();
  const named=JSON.parse(JSON.stringify(options).replaceAll('East Hall','Huangjueya Old Street').replaceAll('West Hall','Huangjueping'));
  for(const fragment of named.fragments)for(const stop of fragment.stops)
    stop.name_zh=stop.entity_id==='east'?'黄桷垭老街':'黄桷坪';
  const bundle=compileRouteBundle(named);assertFrozenRoute(bundle);
  const body=routeReadableMarkdown(bundle);validateRouteDraft(bundle,{body_markdown:body});
  assert.throws(()=>validateRouteDraft(bundle,{body_markdown:body.replaceAll('Huangjueya Old Street','Huangjueping'),
    approved_route_hash:bundle.approved_route_hash}),{code:'ROUTE_TEXT_MISMATCH'});
  const claims=structuredClone(routeSemantics(bundle));claims.stops[0].entity_id='west';
  assert.equal(compareRouteMedia(bundle,{use:'route_overview',route:claims,approved_route_hash:bundle.approved_route_hash}).compatible,false);
});

test('actual renderer decodes PNG and rejects missing stop, reversed arrow, old manifest and changed bytes',async()=>{
  const {bundle}=routeFixture();const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-a2-render-'));
  const rendered=await renderRouteSchematic(bundle,directory);
  assert.equal((await verifyRouteRender(bundle,rendered)).decoded,true);
  assert.equal(rendered.manifest.draw_operations.filter(x=>x.kind==='stop').length,3);
  assert.equal(rendered.manifest.draw_operations.filter(x=>x.kind==='arrow').length,2);
  for(const type of ['stop','arrow']) {
    const input=routeRenderInput(bundle);
    if(type==='stop') input.days[0].stops.pop();else input.days[0].legs[0].to_stop_id=input.days[0].legs[0].from_stop_id;
    await assert.rejects(renderRouteSchematic(bundle,directory,{input}),{code:'ROUTE_RENDER_MISMATCH'});
  }
  await assert.rejects(verifyRouteRender(bundle,{...rendered,manifest:{...rendered.manifest,revision:0}}),{code:'ROUTE_RENDER_MISMATCH'});
  const changedManifest=structuredClone(rendered.manifest);changedManifest.draw_operations.find(x=>x.kind==='arrow').to='wrong-stop';
  await assert.rejects(verifyRouteRender(bundle,{...rendered,manifest:changedManifest}),{code:'ROUTE_RENDER_MISMATCH'});
  const wrongFile=path.join(directory,'different-output.png');
  await sharp({create:{width:1100,height:501,channels:3,background:'white'}}).png().toFile(wrongFile);
  await assert.rejects(verifyRouteRender(bundle,{...rendered,filename:wrongFile}),{code:'ROUTE_RENDER_MISMATCH'});
  if(process.env.A2_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.A2_EVIDENCE_DIR,{recursive:true});
    fs.copyFileSync(rendered.filename,path.join(process.env.A2_EVIDENCE_DIR,'route-example.png'));
    fs.writeFileSync(path.join(process.env.A2_EVIDENCE_DIR,'route-example.json'),JSON.stringify({bundle,...rendered},null,2));
  }
});

test('real SQLite route revisions/artifacts survive backup review restore; stale results rejected without budget writes',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-a2-restore-'));
  const file=path.join(directory,'test.sqlite'),media=path.join(directory,'media');
  const db=openDatabase(file);
  try {
    db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,created_at,updated_at)
      VALUES ('candidate','fixture','fixture','Route','fixture',1,1,0,'now','now')`).run();
    const {fragments,approval}=routeFixture();
    const options={candidateId:'candidate',ownerId:'owner',fragments,approval,mediaAvailability:{assets:[]}};
    const bundle=persistRouteBundle(db,options);
    assert.equal(persistRouteBundle(db,options).revision,1);
    const rendered=await renderRouteSchematic(bundle,media);
    saveRouteArtifact(db,{bundle,kind:'schematic',contentHash:bundle.content_hash,receipt:rendered.manifest,
      mediaPath:rendered.filename,fileHash:rendered.manifest.file_sha256});
    const changed=structuredClone(options);changed.fragments[0].legs[0].mode='bus';
    assert.throws(()=>persistRouteBundle(db,changed),{code:'ROUTE_CHANGE_APPROVAL_REQUIRED'});
    changed.approval.record_id='approval-2';
    assert.equal(persistRouteBundle(db,changed).revision,2);
    assert.throws(()=>saveRouteArtifact(db,{bundle,kind:'text_review',contentHash:'old',receipt:{passed:true}}),{code:'ROUTE_VERSION_STALE'});
    assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
    const snapshot=createBackup({databasePath:file,backupDir:path.join(directory,'backups'),generatedMediaDir:media,retention:2});
    assert.equal(verifyBackup(snapshot.backupPath).integrity,'ok');
    const restored=restoreBackup(snapshot.backupPath,path.join(directory,'restored'));
    assert.equal(restored.mode,'migration-review');
    const restoredDb=new DatabaseSync(restored.databasePath,{readOnly:true});
    try {
      assert.equal(restoredDb.prepare('SELECT count(*) n FROM route_bundles').get().n,2);
      const artifact=restoredDb.prepare('SELECT * FROM route_artifacts').get();
      assert.equal(artifact.file_sha256,rendered.manifest.file_sha256);
      assert.ok(fs.existsSync(artifact.media_path));
      assert.equal(restoredDb.prepare('SELECT count(*) n FROM jobs').get().n,0);
    } finally {restoredDb.close();}
  } finally {db.close();}
});
