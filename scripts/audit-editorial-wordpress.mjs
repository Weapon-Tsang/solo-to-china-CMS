// Read-only remote WordPress verification; never prints credentials or article body.
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';
import { WordPressDraftAdapter } from '../src/wordpress.mjs';

const [databasePath,...draftIds] = process.argv.slice(2);
if (!databasePath || !draftIds.length) throw new Error('usage: audit-editorial-wordpress.mjs DB DRAFT_ID...');
const db = new DatabaseSync(databasePath,{readOnly:true});
db.exec('PRAGMA query_only=ON');
const wp = new WordPressDraftAdapter(loadConfig().wordpress);
try {
  const report = [];
  for (const id of draftIds) {
    const draft = db.prepare('SELECT id,title,revision,status FROM article_drafts WHERE id=?').get(id);
    const publication = db.prepare('SELECT post_id,status,updated_at FROM wordpress_publications WHERE draft_id=?').get(id);
    const visuals = db.prepare(`SELECT slot,alt_text,caption,wordpress_media_id,wordpress_media_url
      FROM article_visuals WHERE draft_id=? ORDER BY slot`).all(id);
    if (!draft || !publication?.post_id) throw new Error(`Draft or WordPress post missing: ${id}`);
    try {
      const remote = await wp.getPost(publication.post_id);
      const raw = String(remote.content?.raw || remote.content?.rendered || '');
      const foundIds = [...raw.matchAll(/(?:wp-image-|"id":|"mediaId":)(\d+)/g)].map((match) => Number(match[1]));
      const expected = visuals.map((visual) => ({slot:visual.slot,mediaId:visual.wordpress_media_id,
        hasAlt: Boolean(String(visual.alt_text || '').trim()),hasCaption:Boolean(String(visual.caption || '').trim()),
        contentMentionsMediaId:foundIds.includes(Number(visual.wordpress_media_id)),
        contentMentionsMediaUrl:Boolean(visual.wordpress_media_url && raw.includes(visual.wordpress_media_url)),
        contentMentionsAlt:Boolean(visual.alt_text && raw.includes(visual.alt_text)),
      }));
      report.push({id,title:draft.title,revision:draft.revision,localStatus:draft.status,
        localWordPressUpdatedAt:publication.updated_at,remotePostId:remote.id,
        remoteStatus:remote.status,remoteModified:remote.modified_gmt || remote.modified,
        rawBytes:Buffer.byteLength(raw),imageTags:(raw.match(/<img\b/g)||[]).length,
        expected,allExpectedMediaPresent:expected.every((item)=>item.mediaId
          && (item.contentMentionsMediaId || item.contentMentionsMediaUrl) && item.hasAlt && item.hasCaption),
      });
    } catch (error) {
      report.push({id,postId:publication.post_id,errorCode:error.code || error.name,
        httpStatus:error.statusCode || null,message:String(error.message || '').slice(0,220)});
    }
  }
  console.log(JSON.stringify(report,null,2));
} finally { db.close(); }
