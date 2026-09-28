import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {mediaHash} from './web-media.mjs';
import {publishMediaBytes} from './atomic-media-file.mjs';
import {COVER_POLICY_VERSION} from './cover-policy.mjs';

let lane=Promise.resolve();
export function renderCoverMedia(input) {
  const task=lane.then(()=>render(input));lane=task.catch(()=>{});return task;
}

async function render({bytes,candidate,outputDir,originalHash=null,quality=82}) {
  const parentHash=mediaHash(bytes);
  if(!candidate?.eligible || candidate.master_hash!==parentHash || candidate.crop?.status!=='planned')
    throw Object.assign(new Error('Cover requires the current qualified master and safe crop plan.'),{code:'COVER_MASTER_CHANGED',retryable:false});
  if(!Number.isInteger(quality) || quality<80 || quality>85)throw new Error('Invalid cover quality.');
  const {crop,width,height}=candidate.crop;
  const policy={version:COVER_POLICY_VERSION,parent_hash:parentHash,original_hash:originalHash,
    purpose:'cover',crop,width,height,quality,orientation:'exif-auto',color:'srgb',metadata:'strip',encoder:sharp.versions};
  const key=mediaHash(JSON.stringify(policy));
  const normalized=sharp(bytes,{failOn:'error',limitInputPixels:40_000_000}).rotate().toColourspace('srgb')
    .extract(crop).resize({width,height,fit:'inside',withoutEnlargement:true});
  let output,format='webp',warning=null;
  try {output=await normalized.clone().webp({quality,effort:4}).toBuffer();}
  catch(error){output=await normalized.clone().png().toBuffer();format='png';warning={code:'WEB_OPTIMIZATION_FAILED',message:error.message};}
  const decoded=await sharp(output,{failOn:'error'}).metadata();
  await sharp(output,{failOn:'error'}).stats();
  if(decoded.width!==width || decoded.height!==height || decoded.width*9!==decoded.height*16
    || decoded.exif || decoded.xmp || decoded.icc || decoded.iptc)
    throw Object.assign(new Error('Cover output failed deterministic verification.'),{code:'COVER_RENDER_INVALID'});
  const localPath=path.join(outputDir,'cover-derivatives',`${key}.${format}`);
  const reused=fs.existsSync(localPath);
  publishMediaBytes(localPath,output);
  return {policy,key,layer:'web_derivative',parent_layer:'editorial_master',parent_hash:parentHash,
    original_hash:originalHash,sha256:mediaHash(output),format,mime:`image/${format}`,bytes:output.length,
    width,height,localPath,reused,verification:'decoded_and_lineage_verified',
    semantic_qa_inherited_from:parentHash,qa_basis:candidate.qa_basis || 'stored_master_qa',
    warning,size_warning:output.length>220*1024?'COVER_ABOVE_SOFT_BYTE_TARGET':null};
}
