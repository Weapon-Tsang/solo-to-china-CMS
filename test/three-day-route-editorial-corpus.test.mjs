import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const article=fs.readFileSync(new URL('../output/three-day-route-20260922/post69-revised.md',import.meta.url),'utf8');

const sections=[
  'Navigating the 3D Mountain City: Maps and Stair Traps',
  'Transit Tactics: Metro for Distance, Taxis for Steep Connections',
  'Day 1: Mountain City Trail to the Riverfront',
  'Day 2: South-Bank Heritage, Then Liangjiang Xiao Ferry',
  'Day 3: Eling, Liziba, Civic Landmarks and Jiangbei',
  'Solo Dining, Pacing and Practical Decisions',
];

const routes=[
  ['Mountain City Trail','Jiefangbei','Baixiangju','Raffles City Chongqing / Chaotianmen','Hongyadong','Jiangtan Park'],
  ['Huangjueya Old Street','Huangge Ancient Road','Longmenhao Old Street','Xiahaoli','Clock Tower Square','Liangjiang Xiao Ferry'],
  ['Eling Park','Liziba',"Chongqing People's Great Hall",'Three Gorges Museum','Guanyinqiao','Beicang Cultural Park'],
];

test('the repaired three-day production corpus keeps prose, packet sections and supplied routes aligned',()=>{
  let cursor=-1;
  for (const section of sections) {
    const index=article.indexOf(`## ${section}`);
    assert.ok(index>cursor,`missing or out-of-order section: ${section}`);
    cursor=index;
  }
  for (const [index,stops] of routes.entries()) {
    const start=article.indexOf(`## ${sections[index+2]}`);
    const end=index===2?article.indexOf(`## ${sections[5]}`):article.indexOf(`## ${sections[index+3]}`);
    const section=article.slice(start,end);
    for (const stop of stops) assert.ok(section.includes(stop),`Day ${index+1} omits ${stop}`);
  }
  assert.match(article,/20[–-]30 RMB/);
  assert.match(article,/terminal station shown on the platform/i);
  assert.match(article,/do not establish today's boarding pier, sailing time or operating status/i);
  assert.match(article,/operator's current route and ticket information/i);
  assert.match(article,/微辣/);
  assert.match(article,/微微辣/);
  assert.match(article,/not guaranteed point-to-point travel times/i);
});
