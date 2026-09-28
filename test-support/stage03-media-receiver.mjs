import http from 'node:http';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mediaHash} from '../src/web-media.mjs';

// This receiver is an independent loopback HTTP fixture, not a WordPress
// adapter. Its public URLs are identities only; no public request is made.
export async function receiverFixture(t, initial, contract, behavior) {
  const state={...initial,media:[],writes:0,uploads:0,reconciles:0,receipts:new Map(),files:new Map(),uploadedMedia:[]};
  const esc=text=>String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const server=http.createServer(async(req,res)=>{
    const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    try {
      if(req.url==='/capabilities') return send({cover_only:true,body_media_only:true,published_media_refresh:true,compare_and_swap:true,
        idempotency_reconciliation:true,site_url:'https://receiver.invalid',contract_hash:contract,contract_commit:initial.contractCommit || 'a'.repeat(40)});
      if(req.url.startsWith('/receipts/')) {state.reconciles++;return send(state.receipts.get(req.url.slice(10)) || null);}
      if(req.method==='GET'&&req.url.startsWith('/media/')) {
        const media=state.uploadedMedia.find(item=>new URL(item.url).pathname===req.url);
        if(!media)return send({error:'missing_media'},404);
        res.writeHead(200,{'content-type':media.mime});return res.end(state.files.get(media.media_id));
      }
      if(req.url==='/page') {
        const html=`<!doctype html><html><head><title>${esc(state.title)}</title><meta name="robots" content="noindex"></head><body>${state.cover?`<img class="wp-image-${state.cover.media_id}" src="${state.cover.url}" alt="East Hall cover" width="${state.cover.width}" height="${state.cover.height}">`:''}<article><h1>${esc(state.title)}</h1><p>${esc(state.body)}</p>${state.media.map(m=>`<figure><img class="wp-image-${m.media_id}" src="${m.url}" alt="East Hall" width="${m.width}" height="${m.height}"><figcaption>East Hall.</figcaption></figure>`).join('')}</article></body></html>`;
        res.writeHead(200,{'content-type':'text/html'});return res.end(html);
      }
      const chunks=[];for await(const chunk of req){chunks.push(chunk);if(chunks.reduce((n,b)=>n+b.length,0)>2_000_000)return send({error:'budget'},413);}
      const bytes=Buffer.concat(chunks);
      if(req.url==='/upload' && req.method==='POST') {
        const digest=mediaHash(bytes),meta=await sharp(bytes).metadata();
        const slot=req.headers['x-slot-id'];state.uploads++;
        const media={slot_id:slot,media_id:900+state.uploads,url:`https://receiver.invalid/media/${digest}.webp`,upload_hash:digest,width:meta.width,height:meta.height,mime:`image/${meta.format}`};
        state.files.set(media.media_id,bytes);state.uploadedMedia.push(media);return send(media);
      }
      if(req.url==='/refresh' && req.method==='POST') {
        const input=JSON.parse(bytes),{plan,idempotency_key,media}=input;
        if(state.receipts.has(idempotency_key))return send(state.receipts.get(idempotency_key));
        if(plan.prior_page_hash!==state.page_hash || plan.prior_modified_gmt!==state.modified)return send({error:'cas_conflict'},409);
        assert.equal(plan.scope,'body_media_only');assert.equal(plan.body_change,false);
        for(const item of media)assert.equal(mediaHash(state.files.get(item.media_id)),item.upload_hash);
        state.writes++;state.media=media;state.page_hash=mediaHash(JSON.stringify({title:state.title,body:state.body,media}));state.modified='2026-09-28T01:00:00';
        const receipt={idempotency_key,post_id:plan.post_id,cms_draft_id:plan.draft_id,cms_revision:plan.draft_revision,
          prior_page_hash:plan.prior_page_hash,protected_content_hash:plan.protected_content_hash,page_payload_hash:state.page_hash,modified_gmt:state.modified,
          media:behavior==='partial'?[]:media};
        state.receipts.set(idempotency_key,receipt);
        if(behavior==='lost')return res.destroy();
        return send(receipt);
      }
      if(req.url==='/cover' && req.method==='POST') {
        const {plan,idempotency_key,media}=JSON.parse(bytes);
        if(state.receipts.has(idempotency_key))return send(state.receipts.get(idempotency_key));
        if(plan.prior_page_hash!==state.page_hash||plan.prior_modified_gmt!==state.modified)return send({error:'cas_conflict'},409);
        assert.equal(plan.scope,'cover_only');
        assert.equal(mediaHash(state.files.get(media.media_id)),plan.upload_hash);
        state.writes++;state.cover=media;state.page_hash=mediaHash(JSON.stringify({title:state.title,body:state.body,media:state.media,cover:media}));
        state.modified='2026-09-28T01:00:00';
        const receipt={idempotency_key,post_id:plan.post_id,cms_draft_id:plan.draft_id,cms_revision:plan.draft_revision,
          prior_page_hash:plan.prior_page_hash,protected_content_hash:plan.protected_content_hash,upload_hash:plan.upload_hash,
          attachment_id:media.media_id,featured_media_id:media.media_id,page_payload_hash:state.page_hash,modified_gmt:state.modified};
        state.receipts.set(idempotency_key,receipt);return send(receipt);
      }
      return send({error:'missing'},404);
    } catch(error){send({error:String(error.message)},500);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const root=`http://127.0.0.1:${server.address().port}`;
  async function request(url,options){const response=await fetch(root+url,options);if(!response.ok)throw new Error(`Fixture HTTP ${response.status}`);return response.json();}
  const receiver={verifiedCapabilities:()=>request('/capabilities'),reconcile:({idempotency_key})=>request(`/receipts/${idempotency_key}`),
    replaceCover:async({idempotency_key,plan,bytes,content_type})=>{
      const media=await request('/upload',{method:'POST',headers:{'content-type':content_type,'x-slot-id':'cover'},body:bytes});
      return request('/cover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idempotency_key,plan,media})});
    },
    refreshMedia:async({idempotency_key,plan,assets})=>{
      const media=[];
      for await(const asset of assets)media.push(await request('/upload',{method:'POST',headers:{'content-type':asset.derivative.mime,'x-slot-id':asset.slot_id},body:asset.stream,duplex:'half'}));
      return request('/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idempotency_key,plan,media})});
    }};
  return {state,receiver,root};
}

\n