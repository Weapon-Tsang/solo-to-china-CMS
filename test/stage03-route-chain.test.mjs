import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {seedRouteProduction} from '../test-support/route-production-fixture.mjs';
import {publishedRouteFixture} from '../test-support/route-decision-fixture.mjs';
import {ContentEngine,applyDeterministicGates} from '../src/ai/content-engine.mjs';
import {Pipeline} from '../src/pipeline.mjs';
import {CommercialComposer} from '../src/commercial.mjs';
import {FrontendContractConsumer} from '../src/frontend-contract.mjs';
import {mediaHash,prepareWebMedia} from '../src/web-media.mjs';
import {validateRenderedHtmlArtifact} from '../src/final-html-validator.mjs';
import {routeRenderInput,verifyRouteRender,routeSchematicVisual,verifyStoredRouteVisual} from '../src/visuals/route-schematic.mjs';
import {evaluatePublicationEligibility} from '../src/publication-eligibility.mjs';
import {auditSourcePhoto,closeLocalPhotoAudit} from '../src/local-photo-audit.mjs';

// Unmodified public contract documents from the already authorized local copy.
// This pins the consumer contract, never asserts that WordPress is deployed.
const pinned=JSON.parse(fs.readFileSync(new URL('../test-support/fixtures/stage03-pinned-contract.json',import.meta.url)));
test('T03-42 legacy route alt receipt remains renderable; v2 is explicit and unknown policy fails closed',async t=>{
  const {repository,db,directory}=repositoryFixture(t),seed=publishedRouteFixture(repository);
  repository.contentConfig.generatedMediaDir=path.join(directory,'media');
  const row=db.prepare('SELECT * FROM article_visuals WHERE draft_id=?').get(seed.draft);
  const legacy=routeSchematicVisual(seed.bundle,{altVersion:1}),metadata=JSON.parse(row.media_metadata_json);
  metadata.route_summary=legacy.media_metadata.route_summary;
  db.prepare('UPDATE article_visuals SET alt_text=?,media_metadata_json=? WHERE id=?').run(legacy.alt_text,JSON.stringify(metadata),row.id);
  const protectedDraft=()=>db.prepare('SELECT title,slug,body_markdown,content_hash,revision,seo_json,schema_jsonld FROM article_drafts WHERE id=?').get(seed.draft);
  const before=protectedDraft();
  const legacyRow=db.prepare('SELECT * FROM article_visuals WHERE id=?').get(row.id);
  const rendered=await repository.renderDraftRouteVisual(legacyRow);
  repository.saveGeneratedVisual(row.id,rendered,{expectedFingerprint:row.asset_fingerprint});
  const stored=db.prepare('SELECT * FROM article_visuals WHERE id=?').get(row.id);
  assert.equal(stored.alt_text,legacy.alt_text);
  assert.equal(verifyStoredRouteVisual(db,seed.bundle,stored,JSON.parse(stored.media_metadata_json)),true);
  assert.deepEqual(protectedDraft(),before);
  const modern=routeSchematicVisual(seed.bundle);
  assert.equal(modern.media_metadata.route_summary.alt_version,2);
  assert.match(modern.alt_text,/3 days/);assert.match(modern.caption,/Day 3/);
  assert.throws(()=>routeSchematicVisual(seed.bundle,{altVersion:99}),{code:'ROUTE_RENDER_MISMATCH'});
  assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});
function contractFor(repository) {
  const [registry,pageSchema,publishPackageSchema]=[pinned.registry_json,pinned.page_schema_json,pinned.publish_package_schema_json].map(JSON.parse);
  assert.equal(mediaHash(JSON.stringify([registry,pageSchema,publishPackageSchema])),pinned.artifact_checksum);
  assert.equal(pinned.frontend_commit_sha,'0c4b327287c016aee138f735a8a13eb2baa74542');
  repository.saveFrontendContractSnapshot({sourceRepository:'Weapon-Tsang/solo-to-china',registrySource:'pinned-cache',pageSchemaSource:'pinned-cache',
    frontendCommitSha:pinned.frontend_commit_sha,contractVersion:pinned.contract_version,schemaVersion:pinned.schema_version,
    checksum:pinned.checksum,artifactChecksum:pinned.artifact_checksum,registry,pageSchema,publishPackageSchema,
    publishPackageVersion:pinned.publish_package_version,activate:true});
  return new FrontendContractConsumer(repository,{registrySource:'pinned-cache',pageSchemaSource:'pinned-cache'},()=>{throw Error('Network contract fetch forbidden');});
}
function engineFor(calls,{mixed=false}={}) {
  const engine=new ContentEngine({apiKey:'unused',model:'controlled'});
  engine.client={enabled:true,async completeJson(request){
    const input=JSON.parse(request.content);calls.push({name:request.name,input});
    if(request.name==='article_bundle_v1') {
      const keys=input.facts.map(f=>f.normalized_key);
      const output={brief:{title:'Beijing route with source conditions',primary_keyword:'Beijing route',audience:['solo'],search_intent:'informational',
        angle:'Follow supported route',reader_promise:'Follow the supported route',outline:[{section_id:'route',heading:'Route',purpose:'Follow supported route',claim_keys:keys}],adaptation_requirements:[],conflict_instructions:[]},
        draft:{title:'Beijing route with source conditions',slug:'beijing-source-route',meta_description:'Supported route sequence with approximate source timings.',
          body_markdown:`## Route\n\n${input.approved_route_table}\n\n${input.facts.map(f=>f.preferred_value).join('\n')}${mixed?'\n\n## Before you go\n\nCheck current opening conditions before departure. Booking requirements are not established by this source.':''}`,
          evidence_ledger:[{section_id:'route',section:'Route',content_node_ids:['node-route'],claim_keys:keys,source_ids:[...new Set(input.facts.flatMap(f=>f.evidence.map(e=>e.source_id)))]}],
          unresolved_conflicts:[],verification_notes:[],seo:{meta_title:'Beijing route — source conditions',focus_keyword:'Beijing route',secondary_keywords:[],search_intent:'informational',key_takeaways:[]},faqs:[],visuals:[]}};
      request.validateOutput?.(output);return {output,model:'controlled-writer'};
    }
    if(request.name==='quality_review_v3')return {model:'controlled-independent-reviewer',output:{passed:true,score:95,
      checks:input.mandatory_requirements.map(r=>({name:r.id,passed:true,detail:'Route section retains the approved stop sequence and about 15 minutes; source assertion, not live navigation.'})),issues:[],unsupported_claims:[],
      route_audit:{checked:true,passed:true,differences:[],approved_route_hash:input.route_bundle.approved_route_hash}}};
    throw Error(`Unexpected model request: ${request.name}`);
  }};
  return engine;
}
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
async function receiver(t,contracts,outputDir) {
  const state={uploads:[],draft:null,requests:[]};
  function render(block) {
    const d=block.data;
    if(block.type==='heading')return `<h${d.level}>${escape(d.text)}</h${d.level}>`;
    if(block.type==='paragraph')return `<p>${d.content}</p>`;
    if(block.type==='list')return `<ul>${d.items.map(x=>`<li>${x}</li>`).join('')}</ul>`;
    if(block.type==='comparison_table')return `<table><caption>${escape(d.caption)}</caption><thead><tr>${d.columns.map(x=>`<th>${escape(x)}</th>`).join('')}</tr></thead><tbody>${d.rows.map(row=>`<tr>${row.map(x=>`<td>${escape(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    if(block.type==='image') {
      const media=state.uploads.find(x=>x.id===d.media_id);assert.ok(media,'Image must have an actual HTTP upload');
      return `<figure><img class="wp-image-${media.id}" src="${media.url}" width="${media.metadata.width}" height="${media.metadata.height}" alt="${escape(d.alt)}"><figcaption>${escape(d.caption)}</figcaption></figure>`;
    }
    throw Error(`Receiver fixture does not render ${block.type}`);
  }
  const server=http.createServer(async(req,res)=>{
    const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    state.requests.push({method:req.method,url:req.url});
    try {
      if(req.method==='GET'&&req.url==='/page') {
        assert.ok(state.draft);const p=state.draft;
        res.writeHead(200,{'content-type':'text/html','x-robots-tag':'noindex'});
        return res.end(`<html><head><title>${escape(p.seo.meta_title)}</title><meta name="description" content="${escape(p.seo.meta_description)}"><meta name="robots" content="noindex"><script type="application/ld+json">${JSON.stringify(p.schema_jsonld)}</script></head><body><article><h1>${escape(p.page.metadata.title)}</h1>${p.page.blocks.map(render).join('')}</article></body></html>`);
      }
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8_000_000)throw Error('Fixture body budget exceeded');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);
      if(req.method==='POST'&&req.url==='/media') {
        const metadata=await sharp(bytes).metadata();await sharp(bytes).stats();
        assert.equal(req.headers['content-type'],`image/${metadata.format}`,'HTTP type must describe decoded bytes');
        const id=state.uploads.length+501,url=`https://receiver.invalid/media/${id}.${metadata.format}`;
        const item={id,url,metadata:{url,width:metadata.width,height:metadata.height,mime:`image/${metadata.format}`,bytes:bytes.length,sha256:mediaHash(bytes),derivatives:[]}};
        state.uploads.push(item);return send(item);
      }
      if(req.method==='POST'&&req.url==='/draft') {
        const payload=JSON.parse(bytes);const validation=contracts.validatePublishPackage(payload);
        assert.equal(validation.valid,true,JSON.stringify(validation.errors));
        assert.equal(payload.publication.status,'draft');
        payload.page.blocks.map(render);state.draft=payload;
        return send({postId:42,postUrl:'https://receiver.invalid/?p=42',previewUrl:'https://receiver.invalid/?p=42&preview=true',status:'draft',deliveryManifest:{page_payload_hash:mediaHash(JSON.stringify(payload.page))}});
      }
      send({error:'Unknown fixture path'},404);
    }catch(error){send({error:error.message},500);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const root=`http://127.0.0.1:${server.address().port}`;
  const post=async(url,body,headers)=>{const r=await fetch(root+url,{method:'POST',headers,body});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
  return {state,root,wordpress:{enabled:true,config:{siteUrl:'https://receiver.invalid'},
    async resolveVisualMedia(visuals,onProgress){const result=[];for(const visual of visuals.filter(v=>v.status==='generated')){
      if(visual.wordpress_media_id)continue;
      const metadata=visual.media_metadata || JSON.parse(visual.media_metadata_json || '{}');
      const isRoute=visual.acquisition_strategy==='render_route_schematic';
      const bytes=fs.readFileSync(visual.media_path);
      const web=await prepareWebMedia({bytes:fs.readFileSync(visual.media_path),contentType:'image/png',outputDir,
        kind:isRoute?'route':'photo',purpose:'body',qa:isRoute?metadata.local_route_qa:{status:'passed',file_hash:mediaHash(bytes)},
        ...(isRoute?{approvedRouteHash:metadata.route_contract.approved_route_hash}:{originalHash:mediaHash(bytes)})});
      const saved=await post('/media',web.bytes,{'content-type':web.receipt.mime});
      saved.metadata.web_derivative=web.receipt;
      saved.metadata.master_hash=web.receipt.parent_hash;
      saved.metadata.upload_bytes_hash=saved.metadata.sha256;
      const item={...saved,visualId:visual.id};onProgress?.(item);result.push(item);
    }return result;},
    upsertContractDraft:payload=>post('/draft',JSON.stringify(payload),{'content-type':'application/json'})}};
}

for(const variant of ['single-source','evidence-composed','mixed'])test(`T03-35/37/41/42 pinned-contract route chain through actual HTTP: ${variant}`,async t=>{
  const f=repositoryFixture(t,{publicSiteUrl:'https://receiver.invalid'}),{repository,db,directory}=f;
  repository.contentConfig.generatedMediaDir=path.join(directory,'media');
  let images=[];
  if(variant==='mixed') {
    t.after(closeLocalPhotoAudit);
    const pixels=Buffer.alloc(1200*800*3);for(let i=0;i<pixels.length;i++)pixels[i]=(i*59+(i>>6)*37+17)&255;
    const bytes=await sharp(pixels,{raw:{width:1200,height:800,channels:3}}).png().toBuffer();
    images=[{url:'https://ci.xhscdn.com/route-photo.png',alt:'East Hall',originalDataUrl:`data:image/png;base64,${bytes.toString('base64')}`,originalSha256:mediaHash(bytes)}];
  }
  const seed=seedRouteProduction(repository,{requiredSchematic:true,dayCount:variant==='evidence-composed'?2:1,images});
  if(images.length) {
    const asset=repository.getSource(seed.source.id).assets[0];
    repository.saveSourceAssetAnalysis(asset.id,{analysis_status:'ready',asset_kind:'documentary_photo',primary_subjects:['East Hall'],
      text_regions:[],photo_regions:[],entities:['East Hall'],reader_text_present:false,confidence:0.95,analysis_version:'fixture'});
    repository.saveLocalPhotoAudit(asset.id,await auditSourcePhoto(asset.local_path));
    repository.refreshSourceMediaBindings(seed.source.id,{dryRun:false});
    repository.saveExperienceExtraction(seed.source.id,{blocks:[],route_fragments:[seed.fragment]},'controlled-source',repository.getExperienceExtractionPackage(seed.source.id));
  }
  let extraFragment=null;
  if(variant==='evidence-composed') {
    const extra=seedRouteProduction(repository,{sourceSuffix:'stage03-independent-source',sourceOnly:true});
    extraFragment=JSON.parse(db.prepare('SELECT route_fragments_json FROM experience_extraction_runs WHERE source_id=? ORDER BY created_at DESC LIMIT 1').get(extra.source.id).route_fragments_json)[0];
    assert.notEqual(extra.source.id,seed.source.id);
  }
  if(variant!=='single-source') {
    const coverage=JSON.parse(db.prepare('SELECT coverage_json FROM content_opportunities WHERE id=?').get(seed.ownerId).coverage_json);
    const fragment=repository.currentRouteFragments(repository.getTopicPackage(seed.candidateId,{opportunityId:seed.ownerId}))[0];
    const fragments=[fragment,...(extraFragment?[extraFragment]:[])];
    const days=fragments.flatMap(f=>f.days.map(day=>({source_day_id:day.day_id,
      stop_ids:f.stops.filter(s=>s.day_id===day.day_id).map(s=>s.stop_id),
      leg_ids:f.legs.filter(l=>f.stops.some(s=>s.stop_id===l.from_stop_id&&s.day_id===day.day_id)).map(l=>l.leg_id)})))
      .map((day,index)=>({...day,label:`Day ${index+1}`}));
    coverage.approval.proposal.route_scope=variant==='mixed'?{mode:'source_route_adaptation',fragment_ids:[fragment.fragment_id]}:
      {mode:'evidence_composed_route',fragment_ids:fragments.map(f=>f.fragment_id),day_count:days.length,days};
    if(variant==='mixed')coverage.approval.proposal.content_type='attraction_guide';
    db.prepare('UPDATE content_opportunities SET coverage_json=? WHERE id=?').run(JSON.stringify(coverage),seed.ownerId);
  }
  const contracts=contractFor(repository),calls=[],remote=await receiver(t,contracts,repository.contentConfig.generatedMediaDir);
  const pipeline=new Pipeline(repository,{enabled:false},{contentEngine:engineFor(calls,{mixed:variant==='mixed'}),frontendContracts:contracts,
    wordpress:remote.wordpress,commercialComposer:new CommercialComposer()});
  db.prepare('DELETE FROM jobs').run(); // Remove only seeded source prerequisite queue.
  repository.enqueue('plan_content',seed.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  for(let i=0;i<10&&!remote.state.draft;i++) {
    await pipeline.runOne();
    const failed=db.prepare("SELECT type,last_error FROM jobs WHERE status='failed'").all();
    if(failed.length){const d=db.prepare('SELECT id FROM article_drafts').get();
      assert.fail(JSON.stringify({failed,eligibility:d?evaluatePublicationEligibility(db,d.id,{phase:'delivery'}):null}));}
    const currentDraft=db.prepare('SELECT id FROM article_drafts').get();
    if(currentDraft){const review=repository.getDraftPackage(currentDraft.id).review;
      if(review)assert.equal(review.passed,true,JSON.stringify(review.issues));}
  }
  assert.ok(remote.state.draft,JSON.stringify(db.prepare('SELECT type,status,last_error FROM jobs').all()));
  assert.deepEqual(calls.map(c=>c.name),['article_bundle_v1','quality_review_v3']);
  const draft=db.prepare('SELECT * FROM article_drafts').get(),pkg=repository.getDraftPackage(draft.id);
  if(extraFragment)assert.equal(new Set(pkg.route_bundle.source_snapshot.map(s=>s.source_id)).size,2);
  const localStrategyAllowed=value=>!applyDeterministicGates({checks:[],issues:[],unsupported_claims:[]},value).issues.some(i=>i.code==='image_strategy_invalid');
  assert.equal(localStrategyAllowed(pkg),true);
  for(const mutation of ['missing-route','stale-hash','wrong-caption','factual-photo']) {
    const bad=structuredClone(pkg),visual=bad.draft.visuals.find(v=>v.acquisition_strategy==='render_route_schematic');
    if(mutation==='missing-route')bad.route_bundle=null;
    if(mutation==='stale-hash')visual.media_metadata.route_contract.approved_route_hash='stale';
    if(mutation==='wrong-caption')visual.caption='Day 2: unrelated route';
    if(mutation==='factual-photo')visual.factual_image_required=true;
    assert.equal(localStrategyAllowed(bad),false,mutation);
  }
  assert.equal(calls[0].input.route_bundle.approved_route_hash,calls[1].input.route_bundle.approved_route_hash);
  assert.match(draft.body_markdown,/about 15 minutes/);assert.doesNotMatch(draft.body_markdown,/0 minutes/);
  const artifact=db.prepare("SELECT * FROM route_artifacts WHERE artifact_kind='schematic'").get();
  const verified=await verifyRouteRender(pkg.route_bundle,{filename:artifact.media_path,manifest:JSON.parse(artifact.receipt_json)});
  assert.equal(verified.decoded,true);assert.ok(remote.state.uploads.length>0);
  if(images.length)assert.equal(remote.state.uploads.length,2,'source scene and real local schematic are both delivered');
  if(images.length)assert.equal(remote.state.draft.page.metadata.featuredMediaId,remote.state.uploads[0].id,
    'the retained scene also supplies the existing contract featured image, not a fabricated additional photo');
  assert.ok(remote.state.uploads.every(x=>['image/webp','image/jpeg','image/png'].includes(x.metadata.mime)));
  assert.ok(remote.state.uploads.some(x=>x.metadata.mime==='image/webp'),'route schematic retains its actual WebP derivative');
  const response=await fetch(remote.root+'/page'),html=await response.text();
  if(variant==='mixed')assert.match(html,/Booking requirements are not established by this source/);
  const inspection=validateRenderedHtmlArtifact({html,httpStatus:response.status,headers:Object.fromEntries(response.headers),status:'draft',
    url:'https://receiver.invalid/?p=42&preview=true',expectedCanonicalUrl:pkg.draft.seo.canonical_url,expectedH1:draft.title,expectedDocumentTitle:remote.state.draft.seo.meta_title,
    expectedFacts:['East Hall','West Hall','about 15 minutes'],expectedMediaIds:remote.state.uploads.map(x=>x.id)});
  assert.equal(inspection.valid,true,JSON.stringify(inspection.errors));
  assert.equal(db.prepare('SELECT status FROM wordpress_publications WHERE draft_id=?').get(draft.id).status,'synced');
  if(process.env.STAGE03_EVIDENCE_DIR) {
    const destination=path.join(process.env.STAGE03_EVIDENCE_DIR,variant);fs.mkdirSync(destination,{recursive:true});
    fs.writeFileSync(path.join(destination,'page.html'),html);
    fs.writeFileSync(path.join(destination,'package.json'),JSON.stringify(remote.state.draft,null,2));
    fs.writeFileSync(path.join(destination,'render-manifest.json'),artifact.receipt_json);
    fs.copyFileSync(artifact.media_path,path.join(destination,'route.png'));
    const web=pkg.draft.visuals.find(v=>v.acquisition_strategy==='render_route_schematic').media_metadata.web_derivative;
    fs.copyFileSync(web.localPath,path.join(destination,'route.webp'));
    fs.writeFileSync(path.join(destination,'inspection.json'),JSON.stringify(inspection,null,2));
  }
  t.diagnostic(JSON.stringify({variant,scope:'controlled model boundary + real CMS jobs + pinned contract + loopback receiver; not WordPress',
    contract_commit:pinned.frontend_commit_sha,requests:remote.state.requests,calls:calls.map(c=>c.name),route_hash:pkg.route_bundle.approved_route_hash,
    draw_days:routeRenderInput(pkg.route_bundle).days.length,html_sha256:mediaHash(html),image_sha256:verified.file_sha256}));
});
