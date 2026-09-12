import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

const extractor=fs.readFileSync(new URL('../extension/page-extractor.js',import.meta.url),'utf8');
function fixture(body, delayed) {
  const {window,document}=parseHTML(`<html lang="en"><body>${body}</body></html>`);
  let elapsed=0;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[1789171200000+elapsed]));}static now(){return 1789171200000+elapsed;}}
  Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get:()=>1000,configurable:true});
  window.HTMLElement.prototype.getBoundingClientRect=()=>({width:600,height:500,bottom:800});
  const viewport={scrollY:0,innerHeight:800,scrollTo({top}){this.scrollY=top;}};
  const context={document,window:viewport,location:new URL('https://www.xiaohongshu.com/explore/fixture123'),navigator:{language:'en'},
    Date:Clock,crypto:webcrypto,TextEncoder,Uint8Array,URL,MutationObserver:window.MutationObserver,
    setTimeout:(callback,delay)=>setImmediate(()=>{elapsed+=delay;delayed?.({document,window,elapsed});callback();}),clearTimeout:clearImmediate,
    chrome:{runtime:{getManifest:()=>({version:'2.0.6'})}}};
  vm.runInNewContext(extractor,context);
  return {api:context.SoloToChinaXhs,document,elapsed:()=>elapsed};
}
const note=media=>`<main id="noteContainer"><h1 id="detail-title">A useful travel note</h1><p id="detail-desc">A complete route through two places with clear timing and choices.</p>${media}</main>`;
const ready=image=>{for(const[key,value]of Object.entries({complete:true,naturalWidth:640,naturalHeight:480}))Object.defineProperty(image,key,{value,configurable:true});};

test('delayed image loading beyond the old wait completes only after actual dimensions arrive',async()=>{
  const {api,elapsed}=fixture(note('<img src="https://media.example/a.png">'),({document,window,elapsed})=>{
    if(elapsed>=4200){const image=document.querySelector('img');if(!image.complete){ready(image);image.dispatchEvent(new window.Event('load',{bubbles:true}));}}
  });
  const result=await api.prepareAndExtract({deadlineMs:12000});
  assert.equal(result.capture.completeness.overall,'complete');assert.ok(elapsed()>=4200);
  assert.equal(result.capture.images[0].kind,'image');assert.equal(result.capture.images[0].width,640);
});
test('unloaded images, unknown carousel count and poster-only videos remain partial; normal notes complete',async()=>{
  for(const media of ['<img src="https://media.example/a.png">','<button aria-label="next">Next</button>','<video src="blob:unavailable" poster="https://media.example/poster.png"></video>']){
    const {api}=fixture(note(media));const {capture}=await api.prepareAndExtract({deadlineMs:7000});
    assert.equal(capture.completeness.overall,'partial_retryable',media);
    if(media.includes('video')){assert.equal(capture.completeness.videos.expected,1);assert.equal(capture.videos.length,0);}
    if(media.includes('button'))assert.equal(capture.completeness.images.expected,null);
  }
  const {api}=fixture(note('<nav>Ignore navigation 999</nav><aside class="comments">Ignore comment 888</aside>'));
  const result=await api.prepareAndExtract({deadlineMs:7000});
  assert.equal(result.capture.completeness.overall,'complete');assert.doesNotMatch(result.capture.text,/999|888/);
});
test('virtualized Favorites enumerate new identities after old cards disappear; one unchanged height is not an end',async()=>{
  const {api,document}=fixture('<section><a href="https://www.xiaohongshu.com/explore/old123">Old</a></section>');
  const first=api.scanFavorites();assert.equal(first.cards[0].externalId,'old123');assert.equal(first.collectionEnd,false);
  document.body.innerHTML='<section><a href="https://www.xiaohongshu.com/explore/new456">New</a></section>';
  const second=api.scanFavorites({seenIdentities:['xiaohongshu:old123']});assert.equal(second.cards[0].externalId,'new456');
  assert.equal((await api.scrollFavoritesWindow()).collectionEnd,false);
  document.body.insertAdjacentHTML('beforeend','<div class="no-more">没有更多</div>');
  assert.equal(api.scanFavorites().collectionEnd,true);
});
test('legacy captures retain an unverified grade and explicit unknown media counts are not upgraded',()=>{
  const input={url:'https://www.xiaohongshu.com/explore/legacy123',text:'A valid original capture body with meaningful details.'};
  assert.equal(normalizeXiaohongshuCapture(input).completeness.verificationLevel,'legacy_unverified');
  const capture=normalizeXiaohongshuCapture({...input,completeness:{images:{expected:null,captured:0,complete:true},videos:{expected:0,complete:true}}});
  assert.equal(capture.completeness.images.expected,null);assert.equal(capture.completeness.overall,'partial_retryable');
});
