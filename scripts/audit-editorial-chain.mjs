// Read-only, bounded production article/media chain snapshot.
import { DatabaseSync } from 'node:sqlite';

const [databasePath, ...draftIds] = process.argv.slice(2);
if (!databasePath) throw new Error('usage: audit-editorial-chain.mjs DB [DRAFT_ID...]');
const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec('PRAGMA query_only=ON');
try {
  const queue = db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE status IN ('queued','running') GROUP BY status").all();
  const activeJobs = db.prepare(`SELECT id,type,entity_id,status,attempts,available_at,created_at,
    production_owner_opportunity_id FROM jobs WHERE status IN ('queued','running')
    ORDER BY created_at ASC LIMIT 30`).all();
  const articles = draftIds.map((draftId) => {
    const draft = db.prepare(`SELECT ad.id,ad.title,ad.status,ad.revision,ad.content_hash,ad.strategy_version,
      cb.strategy_version AS brief_strategy_version,ad.updated_at FROM article_drafts ad
      JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?`).get(draftId);
    if (!draft) throw new Error(`Unknown draft: ${draftId}`);
    const visuals = db.prepare(`SELECT av.id,av.slot,av.status,av.acquisition_strategy,av.alt_text,av.caption,
      av.media_url,av.media_path,av.last_error,av.source_asset_id,sa.original_sha256,sa.local_path,
      sa.local_photo_audit_json,av.media_metadata_json
      FROM article_visuals av LEFT JOIN source_assets sa ON sa.id=av.source_asset_id
      WHERE av.draft_id=? ORDER BY av.slot`).all(draftId).map((row) => {
        const { local_photo_audit_json, media_metadata_json, ...publicRow } = row;
        const audit = local_photo_audit_json ? JSON.parse(local_photo_audit_json) : null;
        const metadata = media_metadata_json ? JSON.parse(media_metadata_json) : null;
        return { ...publicRow, local_photo_audit_status: audit?.status || null,
          source_filename: metadata?.editorial_source_filename || null,
          required_visual_gap: metadata?.required_visual_gap || null,
          quality_qa: metadata?.quality_qa || null,
          source_analysis: metadata?.source_analysis || null,
          visual_decision: metadata?.visual_decision || null,
          authorized_asset_match: metadata?.authorized_asset_match || null,
          binary_qa: metadata?.binary_qa || null };
      });
    const jobs = db.prepare(`SELECT id,type,status,attempts,max_attempts,last_error,last_failure_code,
      created_at,updated_at,production_owner_opportunity_id FROM jobs WHERE entity_id=?
      ORDER BY created_at DESC LIMIT 16`).all(draftId);
    const review = db.prepare(`SELECT id,passed,score,reviewer,issues_json,created_at FROM quality_reviews
      WHERE draft_id=? AND draft_revision=? ORDER BY created_at DESC LIMIT 1`).get(draftId,draft.revision);
    if (review) review.issues = JSON.parse(review.issues_json || '[]');
    if (review) delete review.issues_json;
    const recentReviews = db.prepare(`SELECT draft_revision,passed,score,reviewer,issues_json,created_at
      FROM quality_reviews WHERE draft_id=? ORDER BY created_at DESC LIMIT 3`).all(draftId)
      .map(({issues_json,...row}) => ({...row,issues:JSON.parse(issues_json || '[]')}));
    const page = db.prepare('SELECT status,updated_at FROM frontend_page_compositions WHERE draft_id=?').get(draftId);
    const publishPage = db.prepare('SELECT status,updated_at FROM frontend_publish_compositions WHERE draft_id=?').get(draftId);
    const wordpress = db.prepare(`SELECT post_id,post_url,status,last_error,updated_at
      FROM wordpress_publications WHERE draft_id=?`).get(draftId);
    const mediaManifest = db.prepare(`SELECT minimum_required,approved_no_image,created_at
      FROM required_media_manifests WHERE draft_id=? AND revision=?`).get(draftId,draft.revision);
    return { draft, visuals, jobs, review, recentReviews, page, publishPage, wordpress, mediaManifest };
  });
  console.log(JSON.stringify({queue,activeJobs,articles},null,2));
} finally {
  db.close();
}
