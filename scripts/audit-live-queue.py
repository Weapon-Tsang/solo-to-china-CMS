"""Read-only production queue and zero-visual draft inventory."""

import json
import sqlite3
import sys


database_path = sys.argv[1]
connection = sqlite3.connect(f'file:{database_path}?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
connection.execute('PRAGMA query_only=ON')


def rows(query):
    return [dict(row) for row in connection.execute(query)]


report = {
    'quick_check': rows('PRAGMA quick_check'),
    'job_status': rows('''SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status'''),
    'active_by_type': rows('''SELECT status, type, COUNT(*) AS count,
        MIN(created_at) AS oldest_created_at, MAX(updated_at) AS newest_updated_at
        FROM jobs WHERE status IN ('queued','running')
        GROUP BY status,type ORDER BY status,count DESC,type'''),
    'active_jobs': rows('''SELECT id,type,entity_id,status,attempts,max_attempts,
        available_at,locked_at,created_at,updated_at,last_error,
        production_owner_opportunity_id
        FROM jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100'''),
    'recent_failed_by_type': rows('''SELECT type,COALESCE(last_failure_code,'') AS code,
        COUNT(*) AS count,MAX(updated_at) AS latest_at
        FROM jobs WHERE status='failed' AND updated_at>=datetime('now','-7 days')
        GROUP BY type,code ORDER BY count DESC LIMIT 50'''),
    'zero_visual_drafts': rows('''SELECT ad.id,ad.title,ad.status,ad.revision,
        wp.post_id,wi.status AS wordpress_status,
        co.id AS opportunity_id,co.status AS opportunity_status,
        (SELECT COUNT(*) FROM article_visuals av WHERE av.draft_id=ad.id) AS visual_count,
        (SELECT COUNT(*) FROM required_media_manifests rm WHERE rm.draft_id=ad.id
          AND rm.revision=ad.revision) AS current_manifest_count
        ,(SELECT qr.passed FROM quality_reviews qr WHERE qr.draft_id=ad.id
          AND qr.draft_revision=ad.revision AND qr.draft_content_hash=ad.content_hash
          ORDER BY qr.created_at DESC LIMIT 1) AS latest_matching_text_review_passed
        FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id
        LEFT JOIN content_opportunities co ON co.candidate_id=cb.candidate_id
          AND co.approved_at IS NOT NULL
        LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id
        LEFT JOIN wordpress_content_inventory wi ON wi.site_url=wp.site_url AND wi.post_id=wp.post_id
        WHERE NOT EXISTS (SELECT 1 FROM article_visuals av WHERE av.draft_id=ad.id)
        ORDER BY ad.title'''),
    'photo_source_candidates': rows('''SELECT s.id,s.title,s.author_name,s.author_url,
        s.canonical_url,s.capture_version,s.status,
        COUNT(sa.id) AS image_count
        FROM sources s LEFT JOIN current_source_assets sa ON sa.source_id=s.id AND sa.kind='image'
        WHERE s.title LIKE '%磁器口%' OR s.title LIKE '%湖广%' OR s.title LIKE '%小渡%'
          OR s.title LIKE '%轮渡%' OR s.title LIKE '%渡轮%'
          OR s.author_url LIKE '%158714736%' OR s.author_url LIKE '%109750631%'
          OR s.author_url LIKE '%1621955729%' OR s.author_url LIKE '%26537133631%'
          OR s.author_url LIKE '%670502100%'
        GROUP BY s.id ORDER BY s.title'''),
}
print(json.dumps(report, ensure_ascii=False, indent=2))
connection.close()
