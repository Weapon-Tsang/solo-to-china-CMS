import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {prepareWebMedia,mediaHash} from '../src/web-media.mjs';

const outputDir=path.resolve('output/phase02-b-media');
fs.mkdirSync(outputDir,{recursive:true});
const samples=[
  ['photo','output/three-day-route-20260922/eling-source-slot3.webp','photo'],
  ['text','output/golden-source.webp','text'],
  ['portrait','output/three-day-route-20260922/eling-source-slot2.webp','photo'],
];
const results=[];
for(const [name,source,kind] of samples) {
  const bytes=fs.readFileSync(source),hash=mediaHash(bytes),info=await sharp(bytes).metadata();
  const result=await prepareWebMedia({bytes,contentType:`image/${info.format}`,outputDir,kind,originalHash:hash,
    qa:{status:'passed',file_hash:hash}});
  const filename=path.join(outputDir,`${name}.${result.receipt.format==='jpeg'?'jpg':result.receipt.format}`);
  if(fs.existsSync(filename) && mediaHash(fs.readFileSync(filename))!==result.receipt.sha256)throw new Error('Preserve earlier samples.');
  fs.copyFileSync(result.receipt.localPath,filename);
  results.push({name,source,source_hash:hash,source_bytes:bytes.length,source_width:info.width,source_height:info.height,
    output:filename,...result.receipt,original_preserved:mediaHash(fs.readFileSync(source))===hash});
}
console.log(JSON.stringify({scope:'Existing local authorized source files; compression inspection only. QA fixture is not publication approval. Chinese text is not localized.',
  realProviderCalls:0,results},null,2));
