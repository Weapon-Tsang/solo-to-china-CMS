import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../src/db.mjs';
import { createApplication } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { sha256 } from '../src/utils.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';

export function minimalPdf() {
  const stream='BT /F1 12 Tf 20 100 Td (Huguang Guild Hall - supplement fixture) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text='%PDF-1.4\n';const offsets=[];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(text);
  text+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

export async function pdfFixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cms-a1-pdf-'));
  const storage=path.join(directory,'source-uploads');fs.mkdirSync(storage);
  const databasePath=path.join(directory,'fixture.sqlite');openDatabase(databasePath).close();
  const config=loadConfig({HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:databasePath,CMS_DATA_ROOT:directory,
    SOURCE_UPLOADS_DIR:storage,CAPTURE_MEDIA_UPLOADS_DIR:path.join(directory,'capture-media-uploads'),
    CMS_PROCESS_ROLE:'api',ADMIN_TOKEN:'pdf-fixture-admin',ADMIN_USERNAME:'pdf-test',ADMIN_PASSWORD:'pdf-local-test-only',
    SESSION_SECRET:'isolated-pdf-fixture-session-secret-not-production',
    MAINTENANCE_ENABLED:'false',LOG_LEVEL:'error'});
  const app=createApplication(config),repository=app.repository,db=repository.db;
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:'https://www.xiaohongshu.com/explore/pdf-supplement-fixture',
    title:'PDF supplement fixture',text:'Huguang Guild Hall document. Photo 2 is unrelated.',images:[{url:'https://example.invalid/document.pdf'}]}));
  const parent=repository.getSource(source.id).assets[0].id,bytes=minimalPdf(),filename=path.join(storage,'fixture.pdf');
  fs.writeFileSync(filename,bytes);
  db.prepare(`UPDATE source_assets SET local_path=?,mime_type='application/pdf',original_sha256=?,stored_sha256=?,
    stored_size_bytes=?,storage_status='saved',original_bytes_status='saved_original',durability_status='ORIGINAL_STORED' WHERE id=?`)
    .run(filename,sha256(bytes),sha256(bytes),bytes.length,parent);
  db.prepare(`INSERT INTO entity_aliases(id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,
    resolution_source,confidence,created_at,updated_at,entity_type,granularity)
    VALUES ('pdf-hall','chongqing','hall','hall','Huguang Guild Hall','["湖广会馆"]','manual',1,'now','now','attraction','specific_entity')`).run();
  await app.start();
  return {app,repository,db,config,directory,storage,databasePath,source,parent,url:`http://127.0.0.1:${app.server.address().port}`};
}
