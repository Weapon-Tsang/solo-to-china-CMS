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
  return {api:context.SoloToChinaXhs,document,elapsed:()=>elapsed,
    reinject:()=>{vm.runInNewContext(extractor,context);return context.SoloToChinaXhs;},
    navigate:(url)=>{context.location=new URL(url);vm.runInNewContext(extractor,context);return context.SoloToChinaXhs;}};
}
const note=media=>`<main id="noteContainer"><h1 id="detail-title">A useful travel note</h1><p id="detail-desc">A complete route through two places with clear timing and choices.</p>${media}</main>`;
const ready=image=>{for(const[key,value]of Object.entries({complete:true,naturalWidth:640,naturalHeight:480}))Object.defineProperty(image,key,{value,configurable:true});};

test('lazy image dimensions do not keep a fully discoverable note partial',async()=>{
  const {api,elapsed}=fixture(note('<img src="https://media.example/a.png">'),({document,window,elapsed})=>{
    if(elapsed>=4200){const image=document.querySelector('img');if(!image.complete){ready(image);image.dispatchEvent(new window.Event('load',{bubbles:true}));}}
  });
  const result=await api.prepareAndExtract({deadlineMs:12000});
  assert.equal(result.capture.completeness.overall,'complete');assert.ok(elapsed()<4200);
  assert.equal(result.capture.images[0].kind,'image');assert.equal(result.capture.images[0].url,'https://media.example/a.png');
});
test('unknown carousel count and actual poster-only videos remain partial; live-video chrome does not',async()=>{
  for(const media of ['<button aria-label="next">Next</button>','<video src="blob:unavailable" poster="https://media.example/poster.png"></video>']){
    const {api}=fixture(note(media));const {capture}=await api.prepareAndExtract({deadlineMs:7000});
    assert.equal(capture.completeness.overall,'partial_retryable',media);
    if(media.includes('video')){assert.equal(capture.completeness.videos.expected,1);assert.equal(capture.videos.length,0);}
    if(media.includes('button'))assert.equal(capture.completeness.images.expected,null);
  }
  const {api}=fixture(note('<nav>Ignore navigation 999</nav><aside class="comments">Ignore comment 888</aside>'));
  const result=await api.prepareAndExtract({deadlineMs:7000});
  assert.equal(result.capture.completeness.overall,'complete');assert.doesNotMatch(result.capture.text,/999|888/);
  const live=fixture(note('<img src="https://media.example/a.png"><video class="live-video live-video-pause" src="blob:https://www.xiaohongshu.com/live"></video>'));
  const liveResult=await live.api.prepareAndExtract({deadlineMs:7000});
  assert.equal(liveResult.capture.completeness.overall,'complete');
  assert.equal(liveResult.capture.completeness.videos.expected,0);
  assert.equal(liveResult.capture.videos.length,0);
});
test('note text changes reset content settlement but unrelated comment churn does not',async()=>{
  const {api,elapsed}=fixture(note('<p id="late">First section.</p><aside class="comments">0</aside>'),({document,elapsed})=>{
    document.querySelector('.comments').textContent=String(elapsed);
    if(elapsed>=1400)document.querySelector('#late').textContent='First section and newly loaded route detail.';
  });
  const result=await api.prepareAndExtract({deadlineMs:7000});
  assert.equal(result.capture.completeness.overall,'complete');
  assert.match(result.capture.text,/newly loaded route detail/);
  assert.ok(elapsed()>=3500);
});
test('production-shaped image note captures 19 originals despite 17 missing browser dimensions',async()=>{
  const images=Array.from({length:19},(_,index)=>`<img src="https://media.example/${index}.jpg">`).join('');
  const {api,document}=fixture(note(`${images}<video class="live-video live-video-pause" src="blob:https://www.xiaohongshu.com/live"></video>`));
  for(const image of [...document.querySelectorAll('img')].slice(0,2))ready(image);
  const result=await api.prepareAndExtract({deadlineMs:7000});
  assert.equal(result.capture.completeness.overall,'complete');
  assert.equal(result.capture.completeness.images.expected,19);
  assert.equal(result.capture.images.length,19);
  assert.equal(result.capture.images.filter(image=>!image.width).length,17);
  assert.equal(result.capture.completeness.videos.expected,0);
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
test('a new Favorites board discovers note links without treating the board link as a note',()=>{
  const {api}=fixture('<a href="/board/board123">Collection</a><section class="note-item"><a href="/board/board123/note456?xsec_token=temporary"><img src="https://media.example/cover.jpg"></a></section>');
  const result=api.scanFavorites();
  assert.equal(result.cards.length,1);
  assert.equal(result.cards[0].externalId,'note456');
  assert.match(result.cards[0].navigationUrl,/\/board\/board123\/note456\?xsec_token=temporary/);
});
test('reinjecting the extractor does not reset stable end detection on an empty collection',async()=>{
  const page=fixture('<main>Empty collection</main>');
  let api=page.api;
  for(let pass=0;pass<5;pass++){
    assert.equal(api.scanFavorites().cards.length,0);
    const scroll=await api.scrollFavoritesWindow();
    assert.equal(scroll.collectionEnd,pass>=3);
    api=page.reinject();
  }
  assert.equal(api.scanFavorites().collectionEnd,true);
  assert.equal(api.discoveryObservation.stableRounds,5);
  api=page.navigate('https://www.xiaohongshu.com/board/another123');
  assert.equal(api.discoveryObservation.stableRounds,0);
  assert.equal(api.scanFavorites().collectionEnd,false);
});
test('legacy captures retain an unverified grade and explicit unknown media counts are not upgraded',()=>{
  const input={url:'https://www.xiaohongshu.com/explore/legacy123',text:'A valid original capture body with meaningful details.'};
  assert.equal(normalizeXiaohongshuCapture(input).completeness.verificationLevel,'legacy_unverified');
  const capture=normalizeXiaohongshuCapture({...input,completeness:{images:{expected:null,captured:0,complete:true},videos:{expected:0,complete:true}}});
  assert.equal(capture.completeness.images.expected,null);assert.equal(capture.completeness.overall,'partial_retryable');
});
