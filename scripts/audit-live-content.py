"""Read-only inventory of production article, media, and model states.

Run against a live SQLite database in mode=ro, or an isolated snapshot. The
report contains identifiers and aggregate counts but no article/source text.
"""
import json
import sqlite3
import sys

database_path = sys.argv[1]
connection = sqlite3.connect(f'file:{database_path}?mode=ro', uri=True)
connection.row_factory = sqlite3.Row


def rows(query):
    return [dict(row) for row in connection.execute(query)]


report = {
    'schema': rows('SELECT MAX(version) AS version FROM schema_migrations')[0]['version'],
    'counts': {table: rows(f'SELECT COUNT(*) AS count FROM {table}')[0]['count']
               for table in ('sources', 'source_assets', 'article_drafts', 'article_visuals',
                             'wordpress_publications', 'wordpress_content_inventory', 'jobs')},
    'drafts': rows('''SELECT ad.id,ad.status,ad.revision,wp.post_id,wp.status AS cms_wordpress_status,
        wi.status AS inventory_status,wi.synced_at AS inventory_synced_at,
        COUNT(DISTINCT av.id) AS visual_count,
        SUM(CASE WHEN av.acquisition_strategy='use_authorized_source_image' THEN 1 ELSE 0 END) AS retained_originals,
        SUM(CASE WHEN av.status<>'generated' THEN 1 ELSE 0 END) AS unfinished_visuals,
        SUM(CASE WHEN av.source_asset_id IS NOT NULL AND saa.analysis_status='ready'
          AND saa.asset_kind='documentary_photo' AND saa.reader_text_present=0
          AND json_array_length(COALESCE(saa.editor_ui_regions_json,'[]'))=0 THEN 1 ELSE 0 END) AS clean_originals
        FROM article_drafts ad LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id
        LEFT JOIN wordpress_content_inventory wi ON wi.site_url=wp.site_url AND wi.post_id=wp.post_id
        LEFT JOIN article_visuals av ON av.draft_id=ad.id
        LEFT JOIN source_asset_analyses saa ON saa.asset_id=av.source_asset_id
        GROUP BY ad.id ORDER BY ad.id'''),
    'source_photos': rows('''SELECT COUNT(*) AS total,
        SUM(CASE WHEN saa.analysis_status='ready' AND saa.asset_kind='documentary_photo'
          AND saa.reader_text_present=0 AND json_array_length(COALESCE(saa.editor_ui_regions_json,'[]'))=0
          THEN 1 ELSE 0 END) AS verified_clean,
        SUM(CASE WHEN sa.language_status='no_text' THEN 1 ELSE 0 END) AS no_text,
        SUM(CASE WHEN sa.language_status='mixed' THEN 1 ELSE 0 END) AS mixed,
        SUM(CASE WHEN sa.width>=1000 AND sa.height>=700 THEN 1 ELSE 0 END) AS high_resolution
        FROM current_source_assets sa LEFT JOIN source_asset_analyses saa ON saa.asset_id=sa.id
        WHERE sa.kind='image' AND sa.durability_status='ORIGINAL_STORED' ''')[0],
    'model_calls': rows('''SELECT role,stage,provider,model,COUNT(*) AS attempts,
        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN cost_status='known' THEN cost_usd ELSE 0 END) AS known_usd,
        SUM(CASE WHEN cost_status<>'known' THEN 1 ELSE 0 END) AS unknown_cost
        FROM model_call_metrics GROUP BY role,stage,provider,model ORDER BY attempts DESC LIMIT 30'''),
}
print(json.dumps(report, ensure_ascii=False, separators=(',', ':')))
