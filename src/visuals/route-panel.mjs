import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {mediaHash} from '../web-media.mjs';
import {publishMediaBytes} from '../atomic-media-file.mjs';

export async function cropRoutePanel(source,contract,outputDir) {
  const panel=contract?.panel_scope;
  const reject=()=>Object.assign(new Error('Route panel bytes do not match the approved source scope.'),
    {code:'ROUTE_PANEL_INVALID',retryable:false});
  if(!contract.compatible || !contract.semantic_compatible || !panel?.valid
    || panel.source_sha256!==mediaHash(source.bytes))throw reject();
  const r=panel.crop;
  if(!r || !['x','y','width','height'].every(k=>Number.isFinite(r[k])) || r.x<0 || r.y<0
    || r.width<=0 || r.height<=0 || r.x+r.width>1 || r.y+r.height>1)throw reject();
  const metadata=await sharp(source.bytes,{limitInputPixels:40_000_000,failOn:'error'}).metadata();
  if((metadata.pages || 1)>1)throw reject();
  const rotated=[5,6,7,8].includes(metadata.orientation);
  const w=rotated?metadata.height:metadata.width,h=rotated?metadata.width:metadata.height;
  const region={left:Math.floor(r.x*w),top:Math.floor(r.y*h),width:Math.floor(r.width*w),height:Math.floor(r.height*h)};
  if(region.width<1 || region.height<1)throw reject();
  const bytes=await sharp(source.bytes,{limitInputPixels:40_000_000,failOn:'error'}).rotate().toColourspace('srgb').extract(region).png().toBuffer();
  await sharp(bytes,{failOn:'error'}).stats();
  const hash=mediaHash(bytes),filename=path.join(outputDir,'route-panels',`${hash}.png`);
  publishMediaBytes(filename,bytes);
  return {bytes,base64:bytes.toString('base64'),mimeType:'image/png',receipt:{version:'route-panel-1',localPath:filename,
    original_hash:panel.source_sha256,sha256:hash,crop:r,width:region.width,height:region.height,
    panel_id:panel.panel_id,scope_hash:panel.scope_hash,approved_route_hash:contract.approved_route_hash,
    semantic_status:'independent_output_qa_required'}};
}

export function panelReceiptValid(contract,receipt,sourceHash) {
  if(!contract?.requires_panel_derivative)return true;
  const panel=contract.panel_scope;
  if(!panel?.valid || !receipt || receipt.original_hash!==sourceHash || receipt.original_hash!==panel.source_sha256
    || receipt.scope_hash!==panel.scope_hash || receipt.approved_route_hash!==contract.approved_route_hash
    || receipt.panel_id!==panel.panel_id || JSON.stringify(receipt.crop)!==JSON.stringify(panel.crop))return false;
  try {return mediaHash(fs.readFileSync(receipt.localPath))===receipt.sha256;} catch {return false;}
}
