import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { publishMediaBytes } from './atomic-media-file.mjs';

export const WEB_MEDIA_VERSION = 'web-media-2';
export const mediaHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const mime = {jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
const extension = {jpeg:'jpg',png:'png',webp:'webp'};
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`),
  {code,retryable:false,details:{substage:'web_optimization'}});
let lane = Promise.resolve();

// Bound decoding/encoding concurrency across articles. No provider is used.
export function prepareWebMedia(input) {
  const task = lane.then(() => transform(input));
  lane = task.catch(() => {});
  return task;
}

async function inspect(bytes, contentType, limitInputPixels) {
  let info;
  try {
    info = await sharp(bytes,{failOn:'error',limitInputPixels}).metadata();
    if ((info.pages || 1)>1) throw fail('MEDIA_ANIMATION_UNSUPPORTED','Original animation retained; a still cannot silently replace it.');
    if (!mime[info.format] || mime[info.format]!==contentType.replace('image/jpg','image/jpeg'))
      throw fail('MEDIA_MIME_MISMATCH','Declared MIME and decoded image format differ.');
    // stats forces full decode; metadata alone accepts truncated images.
    const stats=await sharp(bytes,{failOn:'error',limitInputPixels}).stats();
    info.hasTransparency=info.hasAlpha && !stats.isOpaque;
  } catch(error) {
    if(error.code?.startsWith('MEDIA_'))throw error;
    throw fail(/pixel limit/i.test(error.message)?'MEDIA_DECODE_RESOURCE_LIMIT':'MEDIA_DECODE_FAILED',error.message);
  }
  return info;
}

async function transform({bytes,contentType,outputDir,kind='photo',purpose='body',quality=82,
  maxWidth=1600,limitInputPixels=40_000_000,crop=null,safeRegion=null,qa,
  originalHash=null,approvedRouteHash=null,version=WEB_MEDIA_VERSION,encoder=null}) {
  const parentHash=mediaHash(bytes);
  if(qa?.status!=='passed' || qa.file_hash!==parentHash)
    throw fail('MEDIA_MASTER_QA_REQUIRED','Optimization cannot replace missing or stale master QA.');
  if(!Number.isInteger(quality) || quality<80 || quality>85 || !Number.isInteger(maxWidth) || maxWidth<1)
    throw fail('MEDIA_TRANSFORM_CONFIG_INVALID','Invalid quality or maximum width.');
  const source=await inspect(bytes,contentType,limitInputPixels);
  const rotated=[5,6,7,8].includes(source.orientation);
  const width=rotated?source.height:source.width,height=rotated?source.width:source.height;
  const text=kind!=='photo';
  const validRect=r=>r && ['x','y','width','height'].every(k=>Number.isFinite(r[k]))
    && r.x>=0 && r.y>=0 && r.width>0 && r.height>0 && r.x+r.width<=1 && r.y+r.height<=1;
  if(crop && (!validRect(crop) || !validRect(safeRegion)
    || safeRegion.x<crop.x || safeRegion.y<crop.y || safeRegion.x+safeRegion.width>crop.x+crop.width
    || safeRegion.y+safeRegion.height>crop.y+crop.height))
    throw fail('MEDIA_CROP_UNSAFE','Crop must contain the entire validated safe region.');
  const extract=crop?{left:Math.floor(crop.x*width),top:Math.floor(crop.y*height),
    width:Math.ceil((crop.x+crop.width)*width)-Math.floor(crop.x*width),
    height:Math.ceil((crop.y+crop.height)*height)-Math.floor(crop.y*height)}:null;
  if(extract && (!extract.width || !extract.height))throw fail('MEDIA_CROP_UNSAFE','Crop is smaller than one pixel.');
  const policy={version,parent_hash:parentHash,original_hash:originalHash,purpose,kind,crop,safeRegion,orientation:'exif-auto',
    color:'srgb',metadata:'strip',maxWidth:text?null:maxWidth,format:'webp',quality:text?100:quality,
    lossless:text,approved_route_hash:approvedRouteHash,encoder:sharp.versions};
  const key=mediaHash(JSON.stringify(policy));
  const cacheDir=path.join(outputDir,'web-derivatives');
  const manifestPath=path.join(cacheDir,`${key}.json`);
  const expectedWidth=text?(extract?.width || width):Math.min(maxWidth,extract?.width || width);
  const expectedHeight=Math.round((extract?.height || height)*expectedWidth/(extract?.width || width));
  const validOutput=decoded=>decoded.width===expectedWidth && Math.abs(decoded.height-expectedHeight)<=1
    && (!source.hasTransparency || decoded.hasAlpha) && !decoded.exif && !decoded.xmp && !decoded.iptc && !decoded.icc;
  if(fs.existsSync(manifestPath)) {
    try {
    const receipt=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    const filename=path.join(cacheDir,`${key}.${extension[receipt.format] || 'invalid'}`);
    const cached=fs.readFileSync(filename);
    if(receipt.key!==key || receipt.parent_hash!==parentHash || receipt.sha256!==mediaHash(cached))
      throw fail('MEDIA_CACHE_INVALID','Cached derivative does not match its identity.');
    const decoded=await inspect(cached,receipt.mime,limitInputPixels);
    if(mediaHash(JSON.stringify(receipt.policy))!==key || receipt.original_hash!==originalHash
      || receipt.version!==version || receipt.layer!=='web_derivative' || receipt.parent_layer!=='editorial_master'
      || receipt.semantic_qa_inherited_from!==parentHash || receipt.verification!=='decoded_and_lineage_verified'
      || receipt.bytes!==cached.length || receipt.width!==decoded.width || receipt.height!==decoded.height
      || receipt.format!==decoded.format || !validOutput(decoded))
      throw fail('MEDIA_CACHE_INVALID','Cached receipt differs from its policy or decoded bytes.');
    return {bytes:cached,filename:path.basename(filename),contentType:receipt.mime,
      receipt:{...receipt,localPath:filename},reused:true};
    } catch(error) {
      throw fail('MEDIA_CACHE_INVALID',error.message);
    }
  }
  let normalized=sharp(bytes,{failOn:'error',limitInputPixels}).rotate().toColourspace('srgb');
  if(extract)normalized=normalized.extract(extract);
  if(!text)normalized=normalized.resize({width:maxWidth,withoutEnlargement:true});
  // A metadata-free, normalized fallback must obey the same crop/size rules.
  const fallbackFormat=text?'png':source.format;
  const unchanged=!extract && (text || width<=maxWidth) && (!source.orientation || source.orientation===1)
    && !source.exif && !source.xmp && !source.iptc && !source.icc && source.space==='srgb';
  const fallback=unchanged?bytes:await normalized.clone()[fallbackFormat]().toBuffer();
  const actualFallbackFormat=unchanged?source.format:fallbackFormat;
  let output,format='webp',warning=null;
  try {
    output=encoder?await encoder(normalized.clone(),policy)
      :await normalized.clone().webp({quality:policy.quality,lossless:text,effort:4}).toBuffer();
    await inspect(output,'image/webp',limitInputPixels);
    if(output.length>=fallback.length){output=fallback;format=actualFallbackFormat;}
  } catch(error) {
    output=fallback;format=actualFallbackFormat;
    warning={code:'WEB_OPTIMIZATION_FAILED',message:String(error.message),retry_substage:'web_optimization'};
  }
  const decoded=await inspect(output,mime[format],limitInputPixels);
  if(!validOutput(decoded))
    throw fail('MEDIA_TRANSFORM_INVALID','Output dimensions, transparency or metadata are invalid.');
  const filename=path.join(cacheDir,`${key}.${extension[format]}`);
  const receipt={version,key,layer:'web_derivative',parent_layer:'editorial_master',parent_hash:parentHash,
    original_hash:originalHash,sha256:mediaHash(output),mime:mime[format],format,
    width:decoded.width,height:decoded.height,bytes:output.length,policy,optimized_at:warning?null:new Date().toISOString(),
    verification:'decoded_and_lineage_verified',semantic_qa_inherited_from:parentHash,
    size_warning:Math.min(decoded.width,decoded.height)<320
      ? {code:'MEDIA_LOW_RESOLUTION',action:'retain_without_upscale'} : null,
    readability:text?'lossless_no_downscale':'photo',warning};
  publishMediaBytes(filename,output);
  // Do not cache failures: a retry performs optimization only, using the same master.
  if(!warning)publishMediaBytes(manifestPath,Buffer.from(JSON.stringify(receipt)));
  return {bytes:output,filename:path.basename(filename),contentType:mime[format],
    receipt:{...receipt,localPath:filename},reused:false};
}
