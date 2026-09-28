import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { assertFrozenRoute, routeHash, routeError, canonicalRouteJson } from '../route-bundle.mjs';
import { publishMediaBytes } from '../atomic-media-file.mjs';

const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function routeSchematicVisual(bundle) {
  const input=routeRenderInput(bundle);
  const summary=input.days.map(day=>`${day.label}: ${day.stops.map(s=>s.label).join(' → ')}`).join('; ');
  return {placement:'mid_article',purpose:'Approved route sequence',alt_text:summary,
    caption:`${summary}. Not to scale; source assertions, not live navigation.`,generation_prompt:'',aspect_ratio:'auto',
    image_type:'map_or_route',image_role:'support',image_subject:'Approved route sequence',
    acquisition_strategy:'render_route_schematic',factual_image_required:false,status:'planned',
    media_metadata:{required_visual_obligation:{version:'route-schematic-obligation-1',
      required:bundle.media_obligations.some(o=>o.required && o.kind==='schematic' && o.use==='route_overview'),
      basis:'approved_route_media_obligations'},route_contract:{route_id:bundle.route_id,revision:bundle.revision,
      approved_route_hash:bundle.approved_route_hash,source_route_hash:bundle.source_route_hash},
    route_summary:{approved_route_hash:bundle.approved_route_hash,text:summary},transform_version:'local-route-svg-sharp-1'}};
}
export function routeRenderInput(bundle) {
  assertFrozenRoute(bundle);
  return {route_id:bundle.route_id,revision:bundle.revision,approved_route_hash:bundle.approved_route_hash,
    disclaimer:'Route sequence schematic — not to scale. Source assertions; not live navigation.',
    days:bundle.days.map(day=>({day_id:day.day_id,label:day.label,
      stops:bundle.stops.filter(s=>s.day_id===day.day_id).map(s=>({stop_id:s.stop_id,entity_id:s.entity_id,label:s.name_en || s.name_zh})),
      legs:bundle.legs.filter(l=>bundle.stops.some(s=>s.stop_id===l.from_stop_id && s.day_id===day.day_id))
        .map(l=>({leg_id:l.leg_id,from_stop_id:l.from_stop_id,to_stop_id:l.to_stop_id,mode:l.mode,duration:l.duration,conditions:l.conditions}))}))};
}
export function validateRenderInput(bundle,input) {
  const expected=routeRenderInput(bundle);
  if(canonicalRouteJson(expected)!==canonicalRouteJson(input)) throw routeError('ROUTE_RENDER_MISMATCH',{expected,actual:input});
}

// Input is checked at the actual renderer boundary. Labels and arrows below are
// also the manifest's draw operations, not a second self-reported model output.
function drawRoute(input) {
  const commands=[];let y=70;
  const width=1100;
  for(const day of input.days) {
    commands.push({kind:'day',id:day.day_id,text:day.label,x:40,y});y+=52;
    for(let index=0;index<day.stops.length;index++) {
      const stop=day.stops[index];
      if(String(stop.label).length>64) throw routeError('ROUTE_RENDER_LABEL_TOO_LONG',{stop_id:stop.stop_id});
      commands.push({kind:'stop',id:stop.stop_id,entity_id:stop.entity_id,text:stop.label,x:70,y});
      const next=day.stops[index+1];
      const legs=day.legs.filter(l=>l.from_stop_id===stop.stop_id);
      for(const leg of legs) {
        if(!next || leg.to_stop_id!==next.stop_id) throw routeError('ROUTE_RENDER_UNSUPPORTED',{leg_id:leg.leg_id,field:'nonsequential edge'});
        const duration=leg.duration ? `${leg.duration.approximate?'about ':''}${leg.duration.value} ${leg.duration.unit}` : '';
        const label=[leg.mode || 'Transport not specified',duration,...leg.conditions].filter(Boolean).join(' · ');
        if(label.length>110) throw routeError('ROUTE_RENDER_LABEL_TOO_LONG',{leg_id:leg.leg_id});
        commands.push({kind:'arrow',id:leg.leg_id,from:leg.from_stop_id,to:leg.to_stop_id,x:80,y1:y+15,y2:y+76,
          text:label,label_x:110,label_y:y+48});
      }
      y+=100;
    }
    y+=24;
  }
  const height=y+55;
  if(height>14000) throw routeError('ROUTE_RENDER_TOO_LARGE',{height});
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#f8f7f3"/>
    <g font-family="Arial, Microsoft YaHei, sans-serif" fill="#172c32">
    ${commands.map(c=>c.kind==='arrow'?`<path d="M ${c.x} ${c.y1} V ${c.y2} m -6 -9 l 6 9 l 6 -9" fill="none" stroke="#347b72" stroke-width="3"/><text x="${c.label_x}" y="${c.label_y}" font-size="17">${escape(c.text)}</text>`
      :`<text x="${c.x}" y="${c.y}" font-size="${c.kind==='day'?28:23}" font-weight="${c.kind==='day'?700:400}">${escape(c.text)}</text>`).join('\n')}
    <text x="40" y="${height-28}" font-size="15">${escape(input.disclaimer)}</text></g></svg>`;
  return {commands,width,height,svg};
}

export async function renderRouteSchematic(bundle,directory,{input=routeRenderInput(bundle)}={}) {
  validateRenderInput(bundle,input);
  if(bundle.branches.length) throw routeError('ROUTE_RENDER_UNSUPPORTED',{field:'branches',action:'Retain route; use a branch-capable renderer.'});
  const {commands,width,height,svg}=drawRoute(input);
  const bytes=await sharp(Buffer.from(svg)).png().toBuffer();
  const decoded=await sharp(bytes).raw().toBuffer({resolveWithObject:true});
  if(decoded.info.width!==width || decoded.info.height!==height) throw routeError('ROUTE_RENDER_DECODE_FAILED',decoded.info);
  const fileHash=digest(bytes),filename=path.join(directory,`route-${fileHash}.png`);
  publishMediaBytes(filename,bytes);
  const manifest={version:1,renderer:'local-route-svg-sharp-1',route_id:bundle.route_id,revision:bundle.revision,
    approved_route_hash:bundle.approved_route_hash,source_route_hash:bundle.source_route_hash,transform:'recomposition',
    input_hash:routeHash(input),draw_operations:commands,coverage:input.days.map(d=>({day_id:d.day_id,
      stop_ids:d.stops.map(s=>s.stop_id),leg_ids:d.legs.map(l=>l.leg_id)})),width,height,file_sha256:fileHash,
    svg_sha256:digest(Buffer.from(svg)),not_to_scale:true,visual_review:'NOT_TESTED'};
  publishMediaBytes(`${filename}.manifest.json`,Buffer.from(JSON.stringify(manifest,null,2)));
  return {filename,manifest};
}

export async function verifyRouteRender(bundle,{filename,manifest}) {
  const input=routeRenderInput(bundle),bytes=fs.readFileSync(filename);
  const expected=drawRoute(input);
  const image=await sharp(bytes).raw().toBuffer({resolveWithObject:true});
  if(manifest.approved_route_hash!==bundle.approved_route_hash || manifest.revision!==bundle.revision
    || manifest.input_hash!==routeHash(input) || manifest.file_sha256!==digest(bytes)
    || manifest.svg_sha256!==digest(Buffer.from(expected.svg))
    || canonicalRouteJson(manifest.draw_operations)!==canonicalRouteJson(expected.commands)
    || image.info.width!==manifest.width || image.info.height!==manifest.height)
    throw routeError('ROUTE_RENDER_MISMATCH',{field:'file/manifest/version'});
  return {decoded:true,file_sha256:manifest.file_sha256,width:image.info.width,height:image.info.height};
}

export function verifyStoredRouteVisual(db,bundle,visual,metadata) {
  const artifact=db.prepare(`SELECT * FROM route_artifacts WHERE id=? AND route_id=? AND route_revision=?
    AND approved_route_hash=? AND artifact_kind='schematic'`).get(metadata.route_render_artifact_id || '',
    bundle.route_id,bundle.revision,bundle.approved_route_hash);
  const expected=routeSchematicVisual(bundle),input=routeRenderInput(bundle),draw=drawRoute(input);
  const manifest=metadata.route_render_manifest;
  if(!artifact || !manifest || artifact.media_path!==visual.media_path
    || canonicalRouteJson(JSON.parse(artifact.receipt_json))!==canonicalRouteJson(manifest)
    || manifest.input_hash!==routeHash(input) || manifest.svg_sha256!==digest(Buffer.from(draw.svg))
    || canonicalRouteJson(manifest.draw_operations)!==canonicalRouteJson(draw.commands)
    || manifest.file_sha256!==digest(fs.readFileSync(visual.media_path))
    || visual.caption!==expected.caption || visual.alt_text!==expected.alt_text
    || canonicalRouteJson(metadata.route_contract)!==canonicalRouteJson(expected.media_metadata.route_contract)
    || canonicalRouteJson(metadata.route_summary)!==canonicalRouteJson(expected.media_metadata.route_summary))
    throw routeError('ROUTE_RENDER_MISMATCH',{visual_id:visual.id,field:'stored_visual_receipt'});
  return true;
}
