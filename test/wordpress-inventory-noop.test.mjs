import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';

test('unchanged WordPress inventory refresh does not enqueue full destination rebuilds',t=>{
 const {db,repository}=repositoryFixture(t);
 const enqueued=[]; repository.enqueue=(...args)=>{enqueued.push(args);return 'fixture-job';};
 db.prepare("INSERT INTO destinations(id,name,slug,created_at,updated_at) VALUES ('d','City','city',datetime('now'),datetime('now'))").run();
 const item={postId:42,slug:'city-guide',title:'City Guide',status:'publish',postUrl:'https://site.test/city-guide',modifiedAt:'2026-09-29T00:00:00'};
 repository.replaceWordPressInventory('https://site.test',[item]);
 assert.equal(enqueued.length,1);enqueued.length=0;
 repository.replaceWordPressInventory('https://site.test',[{...item}]);
 assert.equal(enqueued.length,0);
 repository.replaceWordPressInventory('https://site.test',[{...item,title:'Updated Guide'}]);
 assert.equal(enqueued.length,1);enqueued.length=0;
 repository.replaceWordPressInventory('https://site.test',[]);
 assert.equal(enqueued.length,1);
});

test('inventory order is irrelevant while site, URL, publication and modification changes rebuild',t=>{
 const {db,repository}=repositoryFixture(t);
 db.prepare("INSERT INTO destinations(id,name,slug,created_at,updated_at) VALUES ('d','City','city',datetime('now'),datetime('now'))").run();
 const enqueued=[];repository.enqueue=(...args)=>enqueued.push(args);
 let site='https://site.test';
 let items=[1,2].map(postId=>({postId,slug:`guide-${postId}`,title:`Guide ${postId}`,status:'draft',postUrl:`${site}/guide-${postId}`,modifiedAt:'2026-09-29T00:00:00'}));
 repository.replaceWordPressInventory(site,items);enqueued.length=0;
 repository.replaceWordPressInventory(site,[...items].reverse());assert.equal(enqueued.length,0);
 for(const change of [{status:'publish'},{postUrl:'https://site.test/renamed'},{modifiedAt:'2026-09-30T00:00:00'}]){
  items=[{...items[0],...change},items[1]];repository.replaceWordPressInventory(site,items);
  assert.equal(enqueued.length,1);enqueued.length=0;
 }
 site='https://new-site.test';repository.replaceWordPressInventory(site,items);assert.equal(enqueued.length,1);
});
