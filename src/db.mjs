import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const current = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (current < 1) migrationOne(db);
  if (current < 2) migrationTwo(db);
  if (current < 3) migrationThree(db);
  if (current < 4) migrationFour(db);
  if (current < 5) migrationFive(db);
  if (current < 6) migrationSix(db);
  if (current < 7) migrationSeven(db);
  if (current < 8) migrationEight(db);
  if (current < 9) migrationNine(db);
  if (current < 10) migrationTen(db);
  if (current < 11) migrationEleven(db);
  if (current < 12) migrationTwelve(db);
  if (current < 13) migrationThirteen(db);
  if (current < 14) migrationFourteen(db);
  if (current < 15) migrationFifteen(db);
  if (current < 16) migrationSixteen(db);
  if (current < 17) migrationSeventeen(db);
  if (current < 18) migrationEighteen(db);
  if (current < 19) migrationNineteen(db);
  if (current < 20) migrationTwenty(db);
  if (current < 21) migrationTwentyOne(db);
  if (current < 22) migrationTwentyTwo(db);
  if (current < 23) migrationTwentyThree(db);
  if (current < 24) migrationTwentyFour(db);
  if (current < 25) migrationTwentyFive(db);
  if (current < 26) migrationTwentySix(db);
  if (current < 27) migrationTwentySeven(db);
  if (current < 28) migrationTwentyEight(db);
  if (current < 29) migrationTwentyNine(db);
  if (current < 30) migrationThirty(db);
  if (current < 31) migrationThirtyOne(db);
  if (current < 32) migrationThirtyTwo(db);
  if (current < 33) migrationThirtyThree(db);
  if (current < 34) migrationThirtyFour(db);
  if (current < 35) migrationThirtyFive(db);
  if (current < 36) migrationThirtySix(db);
  if (current < 37) migrationThirtySeven(db);
  if (current < 38) migrationThirtyEight(db);
  if (current < 39) migrationThirtyNine(db);
  if (current < 40) migrationForty(db);
  if (current < 41) migrationFortyOne(db);
}

function migrationFortyOne(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN execution_route TEXT NOT NULL DEFAULT 'auto'
        CHECK (execution_route IN ('auto','batch','realtime'));
      ALTER TABLE vertex_batch_items ADD COLUMN transport_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE vertex_batch_items ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT '';
      ALTER TABLE vertex_batch_items ADD COLUMN correlation_warning TEXT NOT NULL DEFAULT '';
      UPDATE vertex_batch_items SET transport_key=batch_item_id WHERE transport_key='';
      CREATE UNIQUE INDEX idx_vertex_batch_transport_key ON vertex_batch_items(run_id,transport_key);
      CREATE INDEX idx_vertex_batch_request_fingerprint ON vertex_batch_items(run_id,request_fingerprint);

      CREATE TABLE vertex_batch_output_anomalies (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES vertex_batch_runs(id) ON DELETE CASCADE,
        transport_key TEXT NOT NULL DEFAULT '',
        request_fingerprint TEXT NOT NULL DEFAULT '',
        output_object TEXT NOT NULL DEFAULT '',
        output_line INTEGER,
        output_checksum TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id,output_checksum,reason)
      );
      CREATE INDEX idx_vertex_batch_output_anomalies_run ON vertex_batch_output_anomalies(run_id,created_at);
      INSERT INTO schema_migrations(version, applied_at) VALUES (41, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationForty(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE vertex_batch_runs ADD COLUMN result_state TEXT NOT NULL DEFAULT 'awaiting_inference'
        CHECK (result_state IN ('awaiting_inference','reading','ingesting','ready_cleanup','cleaned','quarantined'));
      ALTER TABLE vertex_batch_runs ADD COLUMN output_read_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vertex_batch_runs ADD COLUMN output_checksum TEXT NOT NULL DEFAULT '';
      ALTER TABLE vertex_batch_runs ADD COLUMN last_output_error TEXT NOT NULL DEFAULT '';
      ALTER TABLE vertex_batch_runs ADD COLUMN cleanup_eligible_at TEXT;
      ALTER TABLE vertex_batch_runs ADD COLUMN cleaned_at TEXT;
      ALTER TABLE vertex_batch_items ADD COLUMN output_object TEXT NOT NULL DEFAULT '';
      ALTER TABLE vertex_batch_items ADD COLUMN output_line INTEGER;
      ALTER TABLE vertex_batch_items ADD COLUMN output_checksum TEXT NOT NULL DEFAULT '';
      ALTER TABLE vertex_batch_items ADD COLUMN ingested_at TEXT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (40, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtyNine(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE segment_extractions ADD COLUMN input_modality TEXT NOT NULL DEFAULT 'unknown'
        CHECK (input_modality IN ('text','image','video','mixed','unknown'));
      ALTER TABLE segment_extractions ADD COLUMN input_manifest_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE vertex_batch_items ADD COLUMN input_modality TEXT NOT NULL DEFAULT 'unknown'
        CHECK (input_modality IN ('text','image','video','mixed','unknown'));
      ALTER TABLE vertex_batch_items ADD COLUMN input_manifest_json TEXT NOT NULL DEFAULT '{}';
      INSERT INTO schema_migrations(version, applied_at) VALUES (39, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtyEight(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE knowledge_facts ADD COLUMN consensus_method TEXT NOT NULL DEFAULT 'legacy_count';
      ALTER TABLE knowledge_facts ADD COLUMN consensus_confidence REAL NOT NULL DEFAULT 0;
      ALTER TABLE knowledge_facts ADD COLUMN consensus_detail_json TEXT NOT NULL DEFAULT '{}';

      INSERT INTO jobs(id, type, entity_id, status, attempts, max_attempts, available_at, created_at, updated_at, dedupe_key)
      SELECT 'job_evidence_consensus_v38_' || lower(hex(randomblob(12))), 'rebuild_knowledge', ss.destination_slug,
        'queued', 0, 3, datetime('now'), datetime('now'), datetime('now'), 'rebuild_knowledge:' || ss.destination_slug
      FROM structured_sources ss
      WHERE ss.destination_slug<>'' AND ss.destination_slug<>'unknown'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j WHERE j.dedupe_key='rebuild_knowledge:' || ss.destination_slug
            AND j.status IN ('queued','running')
        )
      GROUP BY ss.destination_slug;

      INSERT INTO schema_migrations(version, applied_at) VALUES (38, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtySeven(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE editorial_assignments (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        title TEXT NOT NULL,
        assignment_type TEXT NOT NULL,
        content_type TEXT NOT NULL,
        brief TEXT NOT NULL DEFAULT '',
        target_entities_json TEXT NOT NULL DEFAULT '[]',
        desired_visual TEXT NOT NULL DEFAULT 'illustration'
          CHECK (desired_visual IN ('none','illustration','route_sketch')),
        status TEXT NOT NULL DEFAULT 'evaluating'
          CHECK (status IN ('evaluating','needs_sources','ready','queued','suppressed','deleted')),
        quality_score REAL NOT NULL DEFAULT 0,
        evaluation_json TEXT NOT NULL DEFAULT '{}',
        selected_fact_keys_json TEXT NOT NULL DEFAULT '[]',
        selected_source_ids_json TEXT NOT NULL DEFAULT '[]',
        opportunity_id TEXT REFERENCES content_opportunities(id) ON DELETE SET NULL,
        candidate_id TEXT REFERENCES topic_candidates(id) ON DELETE SET NULL,
        created_by TEXT NOT NULL DEFAULT 'administrator',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX idx_editorial_assignments_active ON editorial_assignments(status,updated_at DESC)
        WHERE deleted_at IS NULL;
      CREATE INDEX idx_editorial_assignments_destination ON editorial_assignments(destination_slug,status,updated_at DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES (37, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtySix(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE vertex_batch_runs (
        id TEXT PRIMARY KEY,
        provider_job_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        location TEXT NOT NULL,
        input_uri TEXT NOT NULL DEFAULT '',
        output_uri_prefix TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('preparing','submitted','succeeded','failed','cancelled','expired')),
        provider_state TEXT NOT NULL DEFAULT '',
        submitted_count INTEGER NOT NULL DEFAULT 0,
        succeeded_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        next_poll_at TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_vertex_batch_runs_active ON vertex_batch_runs(status,next_poll_at,created_at);

      CREATE TABLE vertex_batch_items (
        run_id TEXT NOT NULL REFERENCES vertex_batch_runs(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
        batch_item_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing','submitted','succeeded','failed')),
        last_error TEXT NOT NULL DEFAULT '',
        completed_at TEXT,
        PRIMARY KEY(run_id,job_id)
      );
      CREATE INDEX idx_vertex_batch_items_job ON vertex_batch_items(job_id,status);
      INSERT INTO schema_migrations(version, applied_at) VALUES (36, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtyFive(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE sources ADD COLUMN acquisition_origin TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE sources ADD COLUMN sync_scope_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE sources ADD COLUMN extension_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE sources ADD COLUMN completeness_status TEXT NOT NULL DEFAULT 'complete'
        CHECK (completeness_status IN ('complete','partial_retryable','partial_needs_attention'));
      ALTER TABLE sources ADD COLUMN completeness_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE sources ADD COLUMN authorization_status TEXT NOT NULL DEFAULT 'legacy'
        CHECK (authorization_status IN ('legacy','owner_confirmed','unconfirmed'));
      ALTER TABLE sources ADD COLUMN commercial_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK (commercial_use_allowed IN (0,1));
      ALTER TABLE sources ADD COLUMN editing_allowed INTEGER NOT NULL DEFAULT 0 CHECK (editing_allowed IN (0,1));
      ALTER TABLE sources ADD COLUMN redistribution_allowed INTEGER NOT NULL DEFAULT 0 CHECK (redistribution_allowed IN (0,1));
      ALTER TABLE sources ADD COLUMN publishable INTEGER NOT NULL DEFAULT 0 CHECK (publishable IN (0,1));
      ALTER TABLE sources ADD COLUMN authorization_origin TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE sources ADD COLUMN license_scope_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE sources ADD COLUMN source_availability TEXT NOT NULL DEFAULT 'available'
        CHECK (source_availability IN ('available','unavailable','deleted','private'));

      ALTER TABLE source_assets ADD COLUMN media_identity TEXT NOT NULL DEFAULT '';
      ALTER TABLE source_assets ADD COLUMN width INTEGER;
      ALTER TABLE source_assets ADD COLUMN height INTEGER;
      ALTER TABLE source_assets ADD COLUMN duration REAL;
      ALTER TABLE source_assets ADD COLUMN original_sha256 TEXT NOT NULL DEFAULT '';
      ALTER TABLE source_assets ADD COLUMN ai_derivative_data_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE source_assets ADD COLUMN ai_derivative_sha256 TEXT NOT NULL DEFAULT '';
      ALTER TABLE source_assets ADD COLUMN authorization_status TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE source_assets ADD COLUMN commercial_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK (commercial_use_allowed IN (0,1));
      ALTER TABLE source_assets ADD COLUMN editing_allowed INTEGER NOT NULL DEFAULT 0 CHECK (editing_allowed IN (0,1));
      ALTER TABLE source_assets ADD COLUMN redistribution_allowed INTEGER NOT NULL DEFAULT 0 CHECK (redistribution_allowed IN (0,1));
      ALTER TABLE source_assets ADD COLUMN publishable INTEGER NOT NULL DEFAULT 0 CHECK (publishable IN (0,1));
      ALTER TABLE source_assets ADD COLUMN authorization_origin TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE source_assets ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE source_segments ADD COLUMN capture_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE jobs ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT '';
      UPDATE jobs SET dedupe_key=type || ':' || entity_id WHERE dedupe_key='';
      UPDATE jobs AS duplicate
      SET status='failed', last_error='Superseded duplicate active job during migration 35', updated_at=datetime('now')
      WHERE duplicate.status IN ('queued','running') AND EXISTS (
        SELECT 1 FROM jobs AS keeper
        WHERE keeper.dedupe_key=duplicate.dedupe_key AND keeper.status IN ('queued','running')
          AND (keeper.created_at<duplicate.created_at OR (keeper.created_at=duplicate.created_at AND keeper.id<duplicate.id))
      );
      CREATE UNIQUE INDEX idx_jobs_active_dedupe ON jobs(dedupe_key)
        WHERE dedupe_key<>'' AND status IN ('queued','running');

      UPDATE sources AS current
      SET external_id=NULL
      WHERE external_id IS NOT NULL AND external_id<>'' AND EXISTS (
        SELECT 1 FROM sources AS older
        WHERE older.adapter=current.adapter AND older.external_id=current.external_id
          AND (older.created_at<current.created_at OR (older.created_at=current.created_at AND older.id<current.id))
      );
      DROP INDEX IF EXISTS idx_sources_adapter_external_id;
      CREATE UNIQUE INDEX idx_sources_adapter_external_id_unique ON sources(adapter,external_id)
        WHERE external_id IS NOT NULL AND external_id<>'';
      CREATE INDEX idx_sources_identity_lookup ON sources(adapter,canonical_url,external_id);
      CREATE INDEX idx_sources_sync_scope ON sources(acquisition_origin,sync_scope_key,captured_at DESC);

      UPDATE sources SET acquisition_origin='xhs_manual_extension', authorization_status='owner_confirmed',
        commercial_use_allowed=1, editing_allowed=1, redistribution_allowed=1, publishable=1,
        authorization_origin='xhs_manual_extension',
        license_scope_json='["research","copy","download","edit","crop","compress","format_convert","resize","translate","adapt","redistribute","commercial_publish","wordpress_media","social_media"]'
      WHERE adapter='xiaohongshu';
      UPDATE source_assets SET authorization_status='owner_confirmed', commercial_use_allowed=1, editing_allowed=1,
        redistribution_allowed=1, publishable=1, authorization_origin='xhs_manual_extension',
        provenance_json=json_object(
          'sourceId',source_id,
          'externalId',(SELECT external_id FROM sources WHERE id=source_assets.source_id),
          'canonicalUrl',(SELECT canonical_url FROM sources WHERE id=source_assets.source_id),
          'capturedAt',(SELECT captured_at FROM sources WHERE id=source_assets.source_id),
          'captureVersion',(SELECT capture_version FROM sources WHERE id=source_assets.source_id),
          'mediaSourceUrl',remote_url,'acquisitionOrigin','xhs_manual_extension'
        )
      WHERE source_id IN (SELECT id FROM sources WHERE adapter='xiaohongshu');

      CREATE TABLE capture_versions (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        capture_version INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        raw_html TEXT NOT NULL,
        raw_payload_json TEXT NOT NULL,
        assets_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        completeness_status TEXT NOT NULL CHECK (completeness_status IN ('complete','partial_retryable','partial_needs_attention')),
        completeness_json TEXT NOT NULL,
        acquisition_origin TEXT NOT NULL,
        sync_scope_key TEXT NOT NULL DEFAULT '',
        extension_version TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(source_id,capture_version)
      );
      CREATE INDEX idx_capture_versions_source ON capture_versions(source_id,capture_version DESC);
      CREATE TABLE favorites_sync_runs (
        session_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope_url TEXT NOT NULL,
        scope_label TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL CHECK (mode IN ('incremental','full')),
        status TEXT NOT NULL,
        stats_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        extension_version TEXT NOT NULL DEFAULT '',
        last_error_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_favorites_sync_runs_updated ON favorites_sync_runs(updated_at DESC);
      INSERT INTO capture_versions(
        id,source_id,capture_version,captured_at,raw_text,raw_html,raw_payload_json,assets_json,content_hash,
        completeness_status,completeness_json,acquisition_origin,sync_scope_key,extension_version,created_at
      )
      SELECT
        'capture_version_' || s.id || '_' || s.capture_version,s.id,s.capture_version,s.captured_at,s.raw_text,s.raw_html,s.raw_payload_json,
        COALESCE((SELECT json_group_array(json_object(
          'kind',a.kind,'url',a.remote_url,'alt',a.alt_text,'position',a.position,'localPath',a.local_path,
          'mimeType',a.mime_type,'originalFilename',a.original_filename,'mediaIdentity',a.media_identity
        )) FROM source_assets AS a WHERE a.source_id=s.id),'[]'),s.content_hash,
        'complete','{}',CASE WHEN s.adapter='xiaohongshu' THEN 'xhs_manual_extension' ELSE 'legacy' END,'', '',s.created_at
      FROM sources AS s;

      INSERT INTO schema_migrations(version, applied_at) VALUES (35, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtyFour(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE affiliate_asset_queue_tasks_v34 (
        id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL UNIQUE,
        provider_account_id TEXT NOT NULL REFERENCES affiliate_provider_accounts(id),
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','READY_FOR_MANUAL','COMPLETED','SKIPPED','INVALID')),
        product_category TEXT NOT NULL CHECK (product_category IN ('HOTEL','FLIGHT','TRAIN','ATTRACTION','TOUR_ACTIVITY','FLIGHT_HOTEL','CAR_RENTAL','AIRPORT_TRANSFER','PLANNER')),
        asset_type TEXT NOT NULL CHECK (asset_type IN ('DEEP_LINK','CATEGORY_LINK','SEARCH_BOX','STATIC_BANNER','DYNAMIC_BANNER','PROMOTION')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('ENTITY','ROUTE','AREA','DESTINATION','COUNTRY','CATEGORY','GLOBAL')),
        scope_key TEXT NOT NULL DEFAULT '',
        destination_slug TEXT NOT NULL DEFAULT '',
        area_key TEXT NOT NULL DEFAULT '',
        route_key TEXT NOT NULL DEFAULT '',
        entity_key TEXT NOT NULL DEFAULT '',
        entity_name TEXT NOT NULL DEFAULT '',
        trip_tool_type TEXT NOT NULL CHECK (trip_tool_type IN ('CUSTOM_LINK','HOMEPAGE','HOTELS','FLIGHTS','TRAINS','ATTRACTIONS_TOURS','FLIGHT_HOTEL','CAR_RENTALS','AIRPORT_TRANSFERS','SEARCH_BOX')),
        trip_destination TEXT NOT NULL DEFAULT '',
        trip_property TEXT NOT NULL DEFAULT '',
        trip_departure TEXT NOT NULL DEFAULT '',
        trip_arrival TEXT NOT NULL DEFAULT '',
        trip_pickup_location TEXT NOT NULL DEFAULT '',
        source_trip_url TEXT NOT NULL DEFAULT '',
        trip_sub1 TEXT NOT NULL UNIQUE CHECK (trip_sub1 NOT GLOB '*[^a-z0-9_]*'),
        suggested_title TEXT NOT NULL,
        suggested_description TEXT NOT NULL DEFAULT '',
        suggested_cta_label TEXT NOT NULL DEFAULT 'View option',
        priority INTEGER NOT NULL DEFAULT 0,
        opportunity_id TEXT,
        reason TEXT NOT NULL DEFAULT '',
        score REAL NOT NULL DEFAULT 0,
        intent_strength TEXT NOT NULL DEFAULT '',
        precision_uplift REAL NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL CHECK (source_type IN ('SEED','OPPORTUNITY')),
        affiliate_url TEXT NOT NULL DEFAULT '',
        embed_config_json TEXT NOT NULL DEFAULT '{}',
        valid_from TEXT,
        valid_until TEXT,
        affiliate_asset_id TEXT UNIQUE REFERENCES affiliate_assets(id) ON DELETE SET NULL,
        invalid_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        skipped_at TEXT
      );
      INSERT INTO affiliate_asset_queue_tasks_v34(
        id,task_key,provider_account_id,provider,status,product_category,asset_type,scope_type,scope_key,
        destination_slug,area_key,route_key,entity_key,entity_name,trip_tool_type,trip_destination,trip_property,
        trip_departure,trip_arrival,trip_pickup_location,source_trip_url,trip_sub1,suggested_title,suggested_description,
        suggested_cta_label,priority,opportunity_id,reason,score,intent_strength,precision_uplift,source_type,
        affiliate_url,embed_config_json,valid_from,valid_until,affiliate_asset_id,invalid_reason,created_at,updated_at,
        completed_at,skipped_at
      )
      SELECT
        id,task_key,provider_account_id,provider,status,product_category,asset_type,scope_type,scope_key,
        destination_slug,area_key,route_key,entity_key,entity_name,
        CASE
          WHEN trip_tool_type='CUSTOM_LINK' AND product_category IN ('ATTRACTION','TOUR_ACTIVITY')
            AND scope_type IN ('DESTINATION','COUNTRY') AND status IN ('PENDING','READY_FOR_MANUAL','INVALID') THEN 'ATTRACTIONS_TOURS'
          ELSE trip_tool_type
        END,
        trip_destination,trip_property,trip_departure,trip_arrival,
        CASE WHEN product_category='CAR_RENTAL' THEN COALESCE(NULLIF(trip_destination,''),NULLIF(area_key,''),NULLIF(entity_name,''),scope_key) ELSE '' END,
        source_trip_url,trip_sub1,suggested_title,suggested_description,suggested_cta_label,priority,opportunity_id,
        reason,score,intent_strength,precision_uplift,source_type,affiliate_url,embed_config_json,valid_from,valid_until,
        affiliate_asset_id,invalid_reason,created_at,updated_at,completed_at,skipped_at
      FROM affiliate_asset_queue_tasks;
      DROP TABLE affiliate_asset_queue_tasks;
      ALTER TABLE affiliate_asset_queue_tasks_v34 RENAME TO affiliate_asset_queue_tasks;
      CREATE INDEX idx_affiliate_queue_status_key ON affiliate_asset_queue_tasks(status, task_key);
      CREATE INDEX idx_affiliate_queue_opportunity ON affiliate_asset_queue_tasks(opportunity_id);
      CREATE INDEX idx_affiliate_queue_provider ON affiliate_asset_queue_tasks(provider, status, priority DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES (34, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtyThree(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE affiliate_asset_queue_tasks (
        id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL UNIQUE,
        provider_account_id TEXT NOT NULL REFERENCES affiliate_provider_accounts(id),
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','READY_FOR_MANUAL','COMPLETED','SKIPPED','INVALID')),
        product_category TEXT NOT NULL CHECK (product_category IN ('HOTEL','FLIGHT','TRAIN','ATTRACTION','TOUR_ACTIVITY','FLIGHT_HOTEL','CAR_RENTAL','AIRPORT_TRANSFER','PLANNER')),
        asset_type TEXT NOT NULL CHECK (asset_type IN ('DEEP_LINK','CATEGORY_LINK','SEARCH_BOX','STATIC_BANNER','DYNAMIC_BANNER','PROMOTION')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('ENTITY','ROUTE','AREA','DESTINATION','COUNTRY','CATEGORY','GLOBAL')),
        scope_key TEXT NOT NULL DEFAULT '',
        destination_slug TEXT NOT NULL DEFAULT '',
        area_key TEXT NOT NULL DEFAULT '',
        route_key TEXT NOT NULL DEFAULT '',
        entity_key TEXT NOT NULL DEFAULT '',
        entity_name TEXT NOT NULL DEFAULT '',
        trip_tool_type TEXT NOT NULL CHECK (trip_tool_type IN ('HOTELS','FLIGHTS','TRAINS','CUSTOM_LINK','SEARCH_BOX')),
        trip_destination TEXT NOT NULL DEFAULT '',
        trip_property TEXT NOT NULL DEFAULT '',
        trip_departure TEXT NOT NULL DEFAULT '',
        trip_arrival TEXT NOT NULL DEFAULT '',
        source_trip_url TEXT NOT NULL DEFAULT '',
        trip_sub1 TEXT NOT NULL UNIQUE CHECK (trip_sub1 NOT GLOB '*[^a-z0-9_]*'),
        suggested_title TEXT NOT NULL,
        suggested_description TEXT NOT NULL DEFAULT '',
        suggested_cta_label TEXT NOT NULL DEFAULT 'View option',
        priority INTEGER NOT NULL DEFAULT 0,
        opportunity_id TEXT,
        reason TEXT NOT NULL DEFAULT '',
        score REAL NOT NULL DEFAULT 0,
        intent_strength TEXT NOT NULL DEFAULT '',
        precision_uplift REAL NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL CHECK (source_type IN ('SEED','OPPORTUNITY')),
        affiliate_url TEXT NOT NULL DEFAULT '',
        embed_config_json TEXT NOT NULL DEFAULT '{}',
        valid_from TEXT,
        valid_until TEXT,
        affiliate_asset_id TEXT UNIQUE REFERENCES affiliate_assets(id) ON DELETE SET NULL,
        invalid_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        skipped_at TEXT
      );
      CREATE INDEX idx_affiliate_queue_status_key ON affiliate_asset_queue_tasks(status, task_key);
      CREATE INDEX idx_affiliate_queue_opportunity ON affiliate_asset_queue_tasks(opportunity_id);
      CREATE INDEX idx_affiliate_queue_provider ON affiliate_asset_queue_tasks(provider, status, priority DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES (33, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirtyTwo(db) {
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE frontend_contract_snapshots_new (
        id TEXT PRIMARY KEY,
        source_repository TEXT NOT NULL,
        registry_source TEXT NOT NULL,
        page_schema_source TEXT NOT NULL,
        frontend_commit_sha TEXT,
        contract_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        checksum TEXT NOT NULL,
        registry_json TEXT NOT NULL,
        page_schema_json TEXT NOT NULL,
        diff_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'major_mismatch')),
        synced_at TEXT NOT NULL,
        accepted_at TEXT,
        publish_package_schema_source TEXT NOT NULL DEFAULT '',
        publish_package_version TEXT NOT NULL DEFAULT '',
        publish_package_schema_json TEXT NOT NULL DEFAULT '{}',
        artifact_checksum TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO frontend_contract_snapshots_new(
        id,source_repository,registry_source,page_schema_source,frontend_commit_sha,contract_version,schema_version,
        checksum,registry_json,page_schema_json,diff_json,status,synced_at,accepted_at,publish_package_schema_source,
        publish_package_version,publish_package_schema_json,artifact_checksum
      ) SELECT
        id,source_repository,registry_source,page_schema_source,frontend_commit_sha,contract_version,schema_version,
        checksum,registry_json,page_schema_json,diff_json,status,synced_at,accepted_at,publish_package_schema_source,
        publish_package_version,publish_package_schema_json,artifact_checksum
      FROM frontend_contract_snapshots;
      DROP TABLE frontend_contract_snapshots;
      ALTER TABLE frontend_contract_snapshots_new RENAME TO frontend_contract_snapshots;
      CREATE INDEX idx_frontend_contract_snapshots_status ON frontend_contract_snapshots(status, synced_at DESC);
      CREATE UNIQUE INDEX idx_frontend_contract_artifact_checksum_unique
        ON frontend_contract_snapshots(artifact_checksum) WHERE artifact_checksum <> '';
      INSERT INTO schema_migrations(version, applied_at) VALUES (32, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Migration 32 created foreign-key violations: ${JSON.stringify(violations.slice(0, 5))}`);
}

function migrationThirtyOne(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE content_opportunities ADD COLUMN lifecycle_action TEXT NOT NULL DEFAULT 'create'
        CHECK (lifecycle_action IN ('create','update','merge','retire'));
      ALTER TABLE content_opportunities ADD COLUMN target_post_id INTEGER;
      ALTER TABLE content_opportunities ADD COLUMN publication_impact_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX idx_content_opportunity_lifecycle ON content_opportunities(lifecycle_action, status, updated_at DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES (31, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirty(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE frontend_contract_snapshots ADD COLUMN artifact_checksum TEXT NOT NULL DEFAULT '';
      CREATE INDEX idx_frontend_contract_artifact_checksum ON frontend_contract_snapshots(artifact_checksum);
      INSERT INTO schema_migrations(version, applied_at) VALUES (30, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentyNine(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE model_call_metrics (
        id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        latency_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
        error_code TEXT,
        cost_usd REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_model_call_metrics_created ON model_call_metrics(created_at DESC, stage);
      INSERT INTO schema_migrations(version, applied_at) VALUES (29, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentyEight(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE app_sessions (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES app_users(username) ON UPDATE CASCADE ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX idx_app_sessions_expiry ON app_sessions(expires_at);
      INSERT INTO schema_migrations(version, applied_at) VALUES (28, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentySeven(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE article_visuals ADD COLUMN asset_fingerprint TEXT NOT NULL DEFAULT '';
      ALTER TABLE article_visuals ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE article_visuals ADD COLUMN retry_at TEXT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (27, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentySix(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE article_drafts ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE quality_reviews ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE quality_reviews ADD COLUMN draft_content_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE quality_reviews ADD COLUMN evidence_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE frontend_page_compositions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE frontend_page_compositions ADD COLUMN draft_content_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE frontend_publish_compositions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE frontend_publish_compositions ADD COLUMN draft_content_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE commercial_compositions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE commercial_compositions ADD COLUMN draft_content_hash TEXT NOT NULL DEFAULT '';
      CREATE INDEX idx_quality_reviews_version ON quality_reviews(draft_id, draft_revision, draft_content_hash, created_at DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES (26, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentyFour(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN locked_by TEXT;
      ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
      ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT;
      CREATE INDEX idx_jobs_lease ON jobs(status, lease_expires_at);
      INSERT INTO schema_migrations(version, applied_at) VALUES (24, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentyFive(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE claims ADD COLUMN source_quote_start INTEGER;
      ALTER TABLE claims ADD COLUMN source_quote_end INTEGER;
      ALTER TABLE claims ADD COLUMN source_quote_status TEXT NOT NULL DEFAULT 'legacy'
        CHECK (source_quote_status IN ('legacy','exact','normalized_exact','visual','unsupported'));
      ALTER TABLE evidence_spans ADD COLUMN start_offset INTEGER;
      ALTER TABLE evidence_spans ADD COLUMN end_offset INTEGER;
      ALTER TABLE extraction_coverage ADD COLUMN audit_json TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE source_evidence_reviews (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        previous_authority_level INTEGER NOT NULL,
        authority_level INTEGER NOT NULL,
        previous_verified_at TEXT,
        verified_at TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('verified','unverified','rejected')),
        note TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_source_evidence_reviews_source ON source_evidence_reviews(source_id, created_at DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES (25, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentyThree(db) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE sources ADD COLUMN observed_at TEXT;
      ALTER TABLE sources ADD COLUMN verified_at TEXT;
      ALTER TABLE sources ADD COLUMN effective_from TEXT;
      ALTER TABLE sources ADD COLUMN effective_to TEXT;
      ALTER TABLE sources ADD COLUMN authority_level INTEGER NOT NULL DEFAULT 4 CHECK (authority_level BETWEEN 1 AND 4);
      ALTER TABLE sources ADD COLUMN destination_scopes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE sources ADD COLUMN topic_scopes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE sources ADD COLUMN diagnostic_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE source_assets ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending','processed','failed','retry_required'));
      ALTER TABLE source_assets ADD COLUMN extraction_error TEXT;
      ALTER TABLE source_assets ADD COLUMN processed_at TEXT;

      ALTER TABLE claims ADD COLUMN evidence_span_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE claims ADD COLUMN destination_scopes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE claims ADD COLUMN topic_scopes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE claims ADD COLUMN observed_at TEXT;
      ALTER TABLE claims ADD COLUMN verified_at TEXT;
      ALTER TABLE claims ADD COLUMN effective_from TEXT;
      ALTER TABLE claims ADD COLUMN effective_to TEXT;
      ALTER TABLE claims ADD COLUMN temporal_confidence TEXT NOT NULL DEFAULT 'unknown'
        CHECK (temporal_confidence IN ('unknown','low','medium','high'));
      ALTER TABLE claims ADD COLUMN source_authority_level INTEGER NOT NULL DEFAULT 4 CHECK (source_authority_level BETWEEN 1 AND 4);
      ALTER TABLE claims ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active','excluded'));
      ALTER TABLE claims ADD COLUMN exclusion_reason TEXT;
      ALTER TABLE claims ADD COLUMN excluded_at TEXT;
      ALTER TABLE claims ADD COLUMN excluded_by TEXT;
      ALTER TABLE knowledge_facts ADD COLUMN visibility_status TEXT NOT NULL DEFAULT 'visible' CHECK (visibility_status IN ('visible','hidden'));
      ALTER TABLE knowledge_facts ADD COLUMN visibility_reason TEXT;
      ALTER TABLE knowledge_facts ADD COLUMN visibility_updated_at TEXT;

      CREATE TABLE knowledge_visibility_overrides (
        destination_slug TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        visibility_status TEXT NOT NULL CHECK (visibility_status IN ('visible','hidden')),
        reason TEXT,
        updated_by TEXT NOT NULL DEFAULT 'admin',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(destination_slug, normalized_key)
      );

      CREATE TABLE source_segments (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        segment_type TEXT NOT NULL CHECK (segment_type IN ('text_section','paragraph_group','pdf_page','pdf_page_group','image','infographic','table','map','itinerary_block','video_chapter','other')),
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        raw_text TEXT NOT NULL DEFAULT '',
        page_start INTEGER,
        page_end INTEGER,
        asset_id TEXT REFERENCES source_assets(id) ON DELETE SET NULL,
        image_index INTEGER,
        destination_scopes_json TEXT NOT NULL DEFAULT '[]',
        topic_scopes_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        semantic_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','extracting','extracted','retry_required','failed','complete')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, sequence)
      );
      CREATE INDEX idx_source_segments_source ON source_segments(source_id, sequence);

      CREATE TABLE evidence_spans (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
        asset_id TEXT REFERENCES source_assets(id) ON DELETE SET NULL,
        locator_type TEXT NOT NULL,
        page INTEGER,
        image_index INTEGER,
        timestamp_start REAL,
        timestamp_end REAL,
        quote TEXT NOT NULL DEFAULT '',
        region_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_evidence_spans_segment ON evidence_spans(segment_id, id);

      CREATE TABLE extraction_coverage (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
        extraction_run_id TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','passed','retry_required','failed','manual_review')),
        candidate_evidence_count INTEGER NOT NULL DEFAULT 0,
        claim_count INTEGER NOT NULL DEFAULT 0,
        uncovered_spans_json TEXT NOT NULL DEFAULT '[]',
        important_uncovered_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        audited_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(segment_id, extraction_run_id)
      );
      CREATE INDEX idx_extraction_coverage_source ON extraction_coverage(source_id, status);

      CREATE TABLE segment_extractions (
        segment_id TEXT PRIMARY KEY REFERENCES source_segments(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        result_json TEXT NOT NULL,
        method TEXT NOT NULL,
        model TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_segment_extractions_source ON segment_extractions(source_id, segment_id);

      CREATE TABLE source_families (
        id TEXT PRIMARY KEY,
        family_key TEXT NOT NULL UNIQUE,
        canonical_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE source_family_memberships (
        family_id TEXT NOT NULL REFERENCES source_families(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('EXACT_DUPLICATE','NEAR_DUPLICATE','DERIVED_FROM','PARTIAL_OVERLAP','INDEPENDENT')),
        overlap_score REAL NOT NULL DEFAULT 0,
        incremental_claim_count INTEGER NOT NULL DEFAULT 0,
        related_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
        analysis_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(family_id, source_id)
      );

      CREATE TABLE topic_clusters (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        topic_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        claim_keys_json TEXT NOT NULL DEFAULT '[]',
        source_family_ids_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE coverage_matrices (
        id TEXT PRIMARY KEY,
        topic_key TEXT NOT NULL UNIQUE,
        destination_slug TEXT NOT NULL,
        content_type TEXT NOT NULL,
        requirements_json TEXT NOT NULL,
        readiness_json TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE content_opportunities_new (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        destination_scopes_json TEXT NOT NULL DEFAULT '[]',
        topic_key TEXT NOT NULL UNIQUE,
        strategy_version TEXT NOT NULL,
        source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        recommendation_id TEXT REFERENCES content_recommendations(id) ON DELETE SET NULL,
        candidate_id TEXT REFERENCES topic_candidates(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        content_type TEXT,
        readiness_score REAL NOT NULL,
        readiness_json TEXT NOT NULL DEFAULT '{}',
        coverage_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'recommended' CHECK (status IN ('recommended','approved_waiting_for_evidence','approved_ready','producing','drafted','qa_failed','ready_for_wordpress','wordpress_draft','knowledge_only','cluster','research_required','ignored','suppressed')),
        approved_at TEXT,
        suppression_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO content_opportunities_new(id,destination_slug,destination_scopes_json,topic_key,strategy_version,source_id,source_ids_json,recommendation_id,candidate_id,title,content_type,readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at)
      SELECT id,destination_slug,json_array(destination_slug),topic_key,strategy_version,source_id,
        CASE WHEN source_id IS NULL THEN '[]' ELSE json_array(source_id) END,recommendation_id,candidate_id,title,content_type,readiness_score,coverage_json,coverage_json,
        CASE status WHEN 'approved' THEN 'approved_waiting_for_evidence' WHEN 'planned' THEN 'producing' ELSE status END,
        CASE WHEN status IN ('approved','planned') THEN updated_at ELSE NULL END,created_at,updated_at
      FROM content_opportunities;
      DROP TABLE content_opportunities;
      ALTER TABLE content_opportunities_new RENAME TO content_opportunities;
      CREATE INDEX idx_content_opportunities_destination ON content_opportunities(destination_slug, status, readiness_score DESC);

      ALTER TABLE content_recommendations ADD COLUMN opportunity_id TEXT REFERENCES content_opportunities(id) ON DELETE SET NULL;
      ALTER TABLE topic_candidates ADD COLUMN opportunity_id TEXT REFERENCES content_opportunities(id) ON DELETE SET NULL;
      ALTER TABLE topic_candidates ADD COLUMN recommendation_id TEXT REFERENCES content_recommendations(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX idx_topic_candidates_opportunity ON topic_candidates(opportunity_id) WHERE opportunity_id IS NOT NULL;

      UPDATE content_recommendations SET opportunity_id=(SELECT o.id FROM content_opportunities o WHERE o.recommendation_id=content_recommendations.id LIMIT 1);
      UPDATE topic_candidates SET opportunity_id=(SELECT o.id FROM content_opportunities o WHERE o.candidate_id=topic_candidates.id LIMIT 1),
        recommendation_id=(SELECT o.recommendation_id FROM content_opportunities o WHERE o.candidate_id=topic_candidates.id LIMIT 1);

      INSERT INTO schema_migrations(version, applied_at) VALUES (23, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Migration 23 created foreign-key violations: ${JSON.stringify(violations.slice(0, 5))}`);
}

function migrationTwentyTwo(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE frontend_contract_snapshots ADD COLUMN publish_package_schema_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE frontend_contract_snapshots ADD COLUMN publish_package_version TEXT NOT NULL DEFAULT '';
      ALTER TABLE frontend_contract_snapshots ADD COLUMN publish_package_schema_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE wordpress_publications ADD COLUMN preview_url TEXT;
      ALTER TABLE wordpress_publications ADD COLUMN edit_url TEXT;
      ALTER TABLE wordpress_publications ADD COLUMN response_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE wordpress_publications ADD COLUMN error_code TEXT;
      ALTER TABLE wordpress_publications ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE affiliate_assets ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE affiliate_assets ADD COLUMN alt_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE affiliate_assets ADD COLUMN price_text TEXT NOT NULL DEFAULT '';

      CREATE TABLE frontend_publish_compositions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES article_drafts(id) ON DELETE CASCADE,
        frontend_page_composition_id TEXT NOT NULL REFERENCES frontend_page_compositions(id),
        commercial_composition_id TEXT NOT NULL REFERENCES commercial_compositions(id),
        snapshot_id TEXT NOT NULL REFERENCES frontend_contract_snapshots(id),
        publish_package_version TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        page_schema_version TEXT NOT NULL,
        contract_checksum TEXT NOT NULL,
        commercial_strategy_version TEXT NOT NULL,
        publish_package_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('valid','invalid','stale_contract','delivered','delivery_failed')),
        wordpress_post_id INTEGER,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_frontend_publish_compositions_status
        ON frontend_publish_compositions(status, updated_at DESC);

      INSERT INTO schema_migrations(version, applied_at) VALUES (22, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwentyOne(db) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE source_assets_new (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video_cover', 'video')),
        remote_url TEXT NOT NULL,
        alt_text TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        local_path TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT '',
        original_filename TEXT NOT NULL DEFAULT '',
        UNIQUE(source_id, remote_url)
      );
      INSERT INTO source_assets_new(id, source_id, kind, remote_url, alt_text, position, local_path, mime_type, original_filename)
      SELECT id, source_id, kind, remote_url, alt_text, position, local_path, mime_type, original_filename FROM source_assets;
      DROP TABLE source_assets;
      ALTER TABLE source_assets_new RENAME TO source_assets;

      CREATE TABLE source_files_new (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        file_kind TEXT NOT NULL CHECK (file_kind IN ('pdf','word','image','video')),
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_id, storage_path)
      );
      INSERT INTO source_files_new(id, source_id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at)
      SELECT id, source_id, file_kind, original_filename, mime_type, storage_path, size_bytes, sha256, created_at FROM source_files;
      DROP TABLE source_files;
      ALTER TABLE source_files_new RENAME TO source_files;
      CREATE INDEX idx_source_files_source ON source_files(source_id, created_at);

      INSERT INTO schema_migrations(version, applied_at) VALUES (21, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Migration 21 created foreign-key violations: ${JSON.stringify(violations.slice(0, 5))}`);
}

function migrationTwenty(db) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE sources_new (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL CHECK (adapter IN ('xiaohongshu','manual')),
        external_id TEXT,
        canonical_url TEXT NOT NULL UNIQUE,
        submitted_url TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL DEFAULT 'xiaohongshu_note',
        submission_metadata_json TEXT NOT NULL DEFAULT '{}',
        title TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL DEFAULT '',
        author_url TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        captured_at TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        raw_html TEXT NOT NULL,
        raw_payload_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        capture_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'captured',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO sources_new(id, adapter, external_id, canonical_url, submitted_url, source_kind,
        submission_metadata_json, title, author_name, author_url, published_at, captured_at, raw_text,
        raw_html, raw_payload_json, content_hash, capture_version, status, last_error, created_at, updated_at)
      SELECT id, adapter, external_id, canonical_url, canonical_url, 'xiaohongshu_note', '{}', title,
        author_name, author_url, published_at, captured_at, raw_text, raw_html, raw_payload_json,
        content_hash, capture_version, status, last_error, created_at, updated_at
      FROM sources;

      DROP TABLE sources;
      ALTER TABLE sources_new RENAME TO sources;
      CREATE INDEX idx_sources_adapter_external_id ON sources(adapter, external_id);
      CREATE INDEX idx_sources_kind_captured_at ON sources(source_kind, captured_at DESC);

      ALTER TABLE source_assets ADD COLUMN local_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE source_assets ADD COLUMN mime_type TEXT NOT NULL DEFAULT '';
      ALTER TABLE source_assets ADD COLUMN original_filename TEXT NOT NULL DEFAULT '';

      CREATE TABLE source_files (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        file_kind TEXT NOT NULL CHECK (file_kind IN ('pdf','word','image')),
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_id, storage_path)
      );
      CREATE INDEX idx_source_files_source ON source_files(source_id, created_at);

      INSERT INTO schema_migrations(version, applied_at) VALUES (20, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Migration 20 created foreign-key violations: ${JSON.stringify(violations.slice(0, 5))}`);
}

function migrationNineteen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE extraction_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        method TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        superseded_at TEXT,
        UNIQUE(source_id, revision)
      );
      CREATE INDEX idx_extraction_runs_source ON extraction_runs(source_id, revision DESC);

      ALTER TABLE claims ADD COLUMN extraction_run_id TEXT REFERENCES extraction_runs(id);
      ALTER TABLE claims ADD COLUMN extraction_revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE claims ADD COLUMN claim_role TEXT NOT NULL DEFAULT 'fact'
        CHECK (claim_role IN ('fact','recommendation','personal_experience','promotional_observation','editorial_metadata'));
      ALTER TABLE claims ADD COLUMN knowledge_eligible INTEGER NOT NULL DEFAULT 1 CHECK (knowledge_eligible IN (0,1));
      CREATE INDEX idx_claims_extraction_run ON claims(extraction_run_id, source_id);
      CREATE INDEX idx_claims_knowledge_eligible ON claims(knowledge_eligible, source_id);

      CREATE TABLE claim_history (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        extraction_run_id TEXT REFERENCES extraction_runs(id),
        extraction_revision INTEGER NOT NULL,
        lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('superseded')),
        snapshot_json TEXT NOT NULL,
        superseded_at TEXT NOT NULL,
        UNIQUE(claim_id, extraction_revision)
      );
      CREATE INDEX idx_claim_history_source ON claim_history(source_id, extraction_revision DESC);

      INSERT INTO extraction_runs(id, source_id, revision, method, model, status, created_at, completed_at)
      SELECT 'extract_legacy_' || c.source_id, c.source_id, 1,
        COALESCE(ss.extraction_method, 'legacy'), ss.model, 'active',
        COALESCE(ss.extracted_at, MIN(c.created_at)), COALESCE(ss.extracted_at, MIN(c.created_at))
      FROM claims c LEFT JOIN structured_sources ss ON ss.source_id=c.source_id
      GROUP BY c.source_id;

      UPDATE claims SET extraction_run_id='extract_legacy_' || source_id, extraction_revision=1
      WHERE extraction_run_id IS NULL;

      UPDATE claims SET claim_role='editorial_metadata', knowledge_eligible=0
      WHERE lower(trim(subject)) IN ('recommendations','recommendation','guide','source author');
      UPDATE claims SET claim_role='personal_experience', knowledge_eligible=0
      WHERE lower(trim(subject)) IN ('author''s trip','author trip','the author','source author');

      INSERT INTO jobs(id, type, entity_id, status, attempts, max_attempts, available_at, created_at, updated_at)
      SELECT 'job_claim_review_v19_' || lower(hex(randomblob(12))), 'rebuild_knowledge', ss.destination_slug,
        'queued', 0, 3, datetime('now'), datetime('now'), datetime('now')
      FROM structured_sources ss
      WHERE ss.destination_slug<>'' AND ss.destination_slug<>'unknown'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j WHERE j.type='rebuild_knowledge' AND j.entity_id=ss.destination_slug
            AND j.status IN ('queued','running')
        )
      GROUP BY ss.destination_slug;

      INSERT INTO schema_migrations(version, applied_at) VALUES (19, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationEighteen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE claims ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE claims ADD COLUMN granularity TEXT NOT NULL DEFAULT 'general_topic';
      ALTER TABLE claims ADD COLUMN entity_location_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE claims ADD COLUMN structured_value_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE claims ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE claims ADD COLUMN claim_kind TEXT NOT NULL DEFAULT 'HARD_FACT';
      ALTER TABLE claims ADD COLUMN cardinality TEXT NOT NULL DEFAULT 'SINGLE_VALUE';

      ALTER TABLE knowledge_facts ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE knowledge_facts ADD COLUMN granularity TEXT NOT NULL DEFAULT 'general_topic';
      ALTER TABLE knowledge_facts ADD COLUMN entity_location_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE knowledge_facts ADD COLUMN claim_relations_json TEXT NOT NULL DEFAULT '[]';

      ALTER TABLE entity_aliases ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE entity_aliases ADD COLUMN granularity TEXT NOT NULL DEFAULT 'general_topic';
      ALTER TABLE entity_aliases ADD COLUMN location_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE entity_merge_candidates ADD COLUMN candidate_entity_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE entity_merge_candidates ADD COLUMN candidate_entity_type TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE entity_merge_candidates ADD COLUMN candidate_granularity TEXT NOT NULL DEFAULT 'general_topic';
      ALTER TABLE entity_merge_candidates ADD COLUMN proposed_entity_type TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE entity_merge_candidates ADD COLUMN proposed_granularity TEXT NOT NULL DEFAULT 'general_topic';
      ALTER TABLE entity_merge_candidates ADD COLUMN location_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE entity_merge_candidates ADD COLUMN ai_recommendation TEXT NOT NULL DEFAULT 'UNCERTAIN';
      ALTER TABLE entity_merge_candidates ADD COLUMN suggested_relation TEXT;
      ALTER TABLE entity_merge_candidates ADD COLUMN decision_reason TEXT NOT NULL DEFAULT '';
      ALTER TABLE entity_merge_candidates ADD COLUMN decided_at TEXT;

      CREATE TABLE entity_relations (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        subject_entity_key TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK (relation_type IN (
          'same_as','alias_of','member_of','part_of','located_in','applies_to','related_to',
          'supports','contradicts','generalizes','specializes','derived_from','example_of'
        )),
        object_entity_key TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('model','manual','derived')),
        confidence REAL NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(destination_slug, subject_entity_key, relation_type, object_entity_key)
      );
      CREATE INDEX idx_entity_relations_subject ON entity_relations(destination_slug, subject_entity_key, active);

      CREATE TABLE entity_merge_history (
        id TEXT PRIMARY KEY,
        candidate_id TEXT REFERENCES entity_merge_candidates(id),
        destination_slug TEXT NOT NULL,
        merged_from_entity_ids_json TEXT NOT NULL,
        target_entity_key TEXT NOT NULL,
        decision TEXT NOT NULL,
        operator TEXT NOT NULL,
        ai_recommendation TEXT NOT NULL,
        ai_confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','undone')),
        created_at TEXT NOT NULL,
        undone_at TEXT,
        undo_operator TEXT
      );
      CREATE INDEX idx_entity_merge_history_target ON entity_merge_history(destination_slug, target_entity_key, created_at DESC);

      CREATE TABLE claim_relations (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        claim_a_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        claim_b_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN (
          'EXACT_MATCH','PARAPHRASE','REFINEMENT','ENRICHMENT','GENERALIZATION','COMPATIBLE',
          'OVERLAPPING','COMPLEMENTARY','CONFLICT','UNCERTAIN'
        )),
        can_coexist INTEGER NOT NULL,
        reason TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(claim_a_id, claim_b_id)
      );
      CREATE INDEX idx_claim_relations_destination ON claim_relations(destination_slug, relation_type, updated_at DESC);

      CREATE TABLE claim_review_cases (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        claim_a_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        claim_b_id TEXT REFERENCES claims(id) ON DELETE CASCADE,
        review_type TEXT NOT NULL CHECK (review_type IN (
          'CLAIM_CONFLICT','SOURCE_CONFLICT','TEMPORAL_CONFLICT','GRANULARITY_CONFLICT',
          'NEGATION_EXTRACTION_ERROR','QUALIFIER_EXTRACTION_ERROR'
        )),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(claim_a_id, claim_b_id, review_type)
      );
      CREATE INDEX idx_claim_review_cases_pending ON claim_review_cases(status, review_type, updated_at DESC);

      CREATE TABLE affiliate_provider_accounts (
        id TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        connection_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (connection_mode IN ('MANUAL','OFFICIAL_API','FEED')),
        site_name TEXT NOT NULL DEFAULT '',
        default_language TEXT NOT NULL DEFAULT 'en',
        default_disclosure TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'CONFIGURED' CHECK (status IN ('CONFIGURED','DISABLED','NEEDS_CONFIGURATION')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE affiliate_assets (
        id TEXT PRIMARY KEY,
        provider_account_id TEXT NOT NULL REFERENCES affiliate_provider_accounts(id),
        provider TEXT NOT NULL,
        asset_type TEXT NOT NULL CHECK (asset_type IN ('DEEP_LINK','CATEGORY_LINK','SEARCH_BOX','STATIC_BANNER','DYNAMIC_BANNER','PROMOTION')),
        product_category TEXT NOT NULL CHECK (product_category IN ('HOTEL','FLIGHT','TRAIN','ATTRACTION','TOUR_ACTIVITY','FLIGHT_HOTEL','CAR_RENTAL','AIRPORT_TRANSFER','PLANNER')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('ENTITY','ROUTE','AREA','DESTINATION','COUNTRY','CATEGORY','GLOBAL')),
        scope_key TEXT NOT NULL DEFAULT '',
        destination_slug TEXT NOT NULL DEFAULT '',
        area_key TEXT NOT NULL DEFAULT '',
        route_key TEXT NOT NULL DEFAULT '',
        entity_key TEXT NOT NULL DEFAULT '',
        entity_name TEXT NOT NULL DEFAULT '',
        provider_entity_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        cta_label TEXT NOT NULL DEFAULT 'View option',
        target_url TEXT NOT NULL DEFAULT '',
        embed_config_json TEXT NOT NULL DEFAULT '{}',
        language TEXT NOT NULL DEFAULT 'en',
        priority INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        valid_from TEXT,
        valid_until TEXT,
        source_updated_at TEXT,
        legacy_offer_id TEXT UNIQUE REFERENCES commercial_offers(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_affiliate_assets_resolution ON affiliate_assets(active, product_category, scope_type, destination_slug, scope_key, priority DESC);

      CREATE TABLE affiliate_asset_mappings (
        id TEXT PRIMARY KEY,
        affiliate_asset_id TEXT NOT NULL REFERENCES affiliate_assets(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('ENTITY','ROUTE','AREA','DESTINATION','COUNTRY','CATEGORY','GLOBAL')),
        scope_key TEXT NOT NULL,
        destination_slug TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(affiliate_asset_id, scope_type, scope_key)
      );

      CREATE TABLE commercial_intents (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES article_drafts(id) ON DELETE CASCADE,
        block_index INTEGER NOT NULL,
        block_key TEXT NOT NULL,
        intent_type TEXT NOT NULL,
        product_category TEXT NOT NULL,
        destination_slug TEXT NOT NULL DEFAULT '',
        area_key TEXT NOT NULL DEFAULT '',
        route_key TEXT NOT NULL DEFAULT '',
        entity_key TEXT NOT NULL DEFAULT '',
        intent_strength TEXT NOT NULL CHECK (intent_strength IN ('LOW','MEDIUM','HIGH','VERY_HIGH')),
        decision_stage TEXT NOT NULL,
        recommended_component TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(draft_id, block_key, product_category)
      );
      CREATE INDEX idx_commercial_intents_draft ON commercial_intents(draft_id, block_index);

      CREATE TABLE commercial_slots (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES article_drafts(id) ON DELETE CASCADE,
        intent_id TEXT REFERENCES commercial_intents(id) ON DELETE SET NULL,
        affiliate_asset_id TEXT REFERENCES affiliate_assets(id) ON DELETE SET NULL,
        slot_key TEXT NOT NULL,
        component_type TEXT NOT NULL,
        placement TEXT NOT NULL,
        block_index INTEGER,
        strategy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(draft_id, slot_key)
      );

      CREATE TABLE affiliate_opportunities (
        id TEXT PRIMARY KEY,
        draft_id TEXT REFERENCES article_drafts(id) ON DELETE SET NULL,
        intent_id TEXT REFERENCES commercial_intents(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        product_category TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        score REAL NOT NULL,
        factors_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','addressed','dismissed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(draft_id, product_category, scope_type, scope_key)
      );
      CREATE INDEX idx_affiliate_opportunities_open ON affiliate_opportunities(status, score DESC, updated_at DESC);

      CREATE TABLE commercial_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (event_type IN ('impression','click','booking','commission')),
        article_id TEXT,
        draft_id TEXT REFERENCES article_drafts(id) ON DELETE SET NULL,
        offer_id TEXT,
        affiliate_asset_id TEXT REFERENCES affiliate_assets(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        category TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        component_variant TEXT NOT NULL DEFAULT '',
        placement TEXT NOT NULL DEFAULT '',
        entity_key TEXT NOT NULL DEFAULT '',
        route_key TEXT NOT NULL DEFAULT '',
        destination_slug TEXT NOT NULL DEFAULT '',
        device TEXT NOT NULL DEFAULT '',
        locale TEXT NOT NULL DEFAULT '',
        strategy_version TEXT NOT NULL,
        value_amount REAL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_commercial_events_performance ON commercial_events(provider, category, event_type, occurred_at DESC);

      CREATE TABLE commission_rules (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        product_category TEXT NOT NULL,
        commission_model TEXT NOT NULL,
        effective_rate REAL,
        valid_from TEXT,
        valid_until TEXT,
        promotion_multiplier REAL NOT NULL DEFAULT 1,
        source_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, product_category, valid_from)
      );

      ALTER TABLE commercial_compositions ADD COLUMN asset_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE commercial_compositions ADD COLUMN commercial_blocks_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE commercial_compositions ADD COLUMN content_blocks_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE commercial_compositions ADD COLUMN strategy_version TEXT NOT NULL DEFAULT '';

      INSERT OR IGNORE INTO affiliate_provider_accounts(
        id, provider_key, display_name, connection_mode, site_name, default_language,
        default_disclosure, status, created_at, updated_at
      )
      SELECT 'provider_legacy_' || lower(hex(randomblob(12))), lower(trim(provider)), provider,
        'MANUAL', '', 'en', '', 'CONFIGURED', datetime('now'), datetime('now')
      FROM commercial_offers WHERE trim(provider) <> '' GROUP BY lower(trim(provider));

      INSERT OR IGNORE INTO affiliate_assets(
        id, provider_account_id, provider, asset_type, product_category, scope_type, scope_key,
        destination_slug, title, description, cta_label, target_url, priority, active,
        valid_until, source_updated_at, legacy_offer_id, created_at, updated_at
      )
      SELECT 'asset_' || o.id,
        (SELECT p.id FROM affiliate_provider_accounts p WHERE p.provider_key=lower(trim(o.provider)) LIMIT 1),
        o.provider, 'CATEGORY_LINK',
        CASE o.category WHEN 'hotels' THEN 'HOTEL' WHEN 'attraction_tickets' THEN 'ATTRACTION'
          WHEN 'trains' THEN 'TRAIN' WHEN 'flights' THEN 'FLIGHT' WHEN 'tours_activities' THEN 'TOUR_ACTIVITY'
          WHEN 'airport_transfer' THEN 'AIRPORT_TRANSFER' ELSE 'PLANNER' END,
        'DESTINATION', o.destination_slug, o.destination_slug, o.title, o.description,
        o.cta_label, o.target_url, o.priority, o.active, o.valid_until, o.source_updated_at,
        o.id, o.updated_at, o.updated_at
      FROM commercial_offers o WHERE trim(o.target_url) <> '';

      INSERT INTO schema_migrations(version, applied_at) VALUES (18, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationSeventeen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE claims ADD COLUMN original_normalized_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE claims ADD COLUMN entity_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE claims ADD COLUMN canonical_subject TEXT NOT NULL DEFAULT '';
      ALTER TABLE claims ADD COLUMN entity_aliases_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE claims ADD COLUMN entity_resolution_status TEXT NOT NULL DEFAULT 'unresolved';
      CREATE INDEX idx_claims_entity ON claims(entity_key, canonical_subject);

      ALTER TABLE knowledge_facts ADD COLUMN entity_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE knowledge_facts ADD COLUMN canonical_subject TEXT NOT NULL DEFAULT '';
      ALTER TABLE knowledge_facts ADD COLUMN entity_aliases_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE knowledge_facts ADD COLUMN entity_resolution_status TEXT NOT NULL DEFAULT 'unresolved';
      CREATE INDEX idx_knowledge_facts_entity ON knowledge_facts(destination_id, entity_key);

      CREATE TABLE entity_aliases (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        alias_normalized TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        canonical_subject TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        resolution_source TEXT NOT NULL CHECK (resolution_source IN ('model', 'manual', 'derived')),
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(destination_slug, alias_normalized)
      );
      CREATE INDEX idx_entity_aliases_entity ON entity_aliases(destination_slug, entity_key);

      CREATE TABLE entity_merge_candidates (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        alias TEXT NOT NULL,
        alias_normalized TEXT NOT NULL,
        proposed_entity_key TEXT NOT NULL,
        proposed_canonical_subject TEXT NOT NULL,
        confidence REAL NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(destination_slug, alias_normalized, proposed_entity_key)
      );
      CREATE INDEX idx_entity_merge_candidates_pending ON entity_merge_candidates(status, destination_slug, updated_at DESC);

      INSERT INTO schema_migrations(version, applied_at) VALUES (17, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationSixteen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE frontend_contract_snapshots (
        id TEXT PRIMARY KEY,
        source_repository TEXT NOT NULL,
        registry_source TEXT NOT NULL,
        page_schema_source TEXT NOT NULL,
        frontend_commit_sha TEXT,
        contract_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        checksum TEXT NOT NULL UNIQUE,
        registry_json TEXT NOT NULL,
        page_schema_json TEXT NOT NULL,
        diff_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'major_mismatch')),
        synced_at TEXT NOT NULL,
        accepted_at TEXT
      );
      CREATE INDEX idx_frontend_contract_snapshots_status ON frontend_contract_snapshots(status, synced_at DESC);

      CREATE TABLE frontend_contract_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_snapshot_id TEXT REFERENCES frontend_contract_snapshots(id),
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        status TEXT NOT NULL DEFAULT 'unconfigured'
          CHECK (status IN ('unconfigured', 'syncing', 'healthy', 'stale', 'major_mismatch', 'invalid')),
        updated_at TEXT NOT NULL
      );
      INSERT INTO frontend_contract_state(singleton, status, updated_at) VALUES (1, 'unconfigured', datetime('now'));

      CREATE TABLE frontend_page_plans (
        id TEXT PRIMARY KEY,
        brief_id TEXT NOT NULL UNIQUE REFERENCES content_briefs(id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL REFERENCES frontend_contract_snapshots(id),
        contract_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        contract_checksum TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        validation_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('ready', 'invalid', 'failed')),
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE frontend_page_compositions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES article_drafts(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES frontend_page_plans(id) ON DELETE SET NULL,
        snapshot_id TEXT NOT NULL REFERENCES frontend_contract_snapshots(id),
        contract_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        contract_checksum TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'stale_contract')),
        model TEXT,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_frontend_page_compositions_snapshot ON frontend_page_compositions(snapshot_id, status);

      CREATE TABLE frontend_capability_requests (
        id TEXT PRIMARY KEY,
        draft_id TEXT REFERENCES article_drafts(id) ON DELETE SET NULL,
        brief_id TEXT REFERENCES content_briefs(id) ON DELETE SET NULL,
        semantic_need TEXT NOT NULL,
        use_case TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'addressed', 'dismissed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_frontend_capability_requests_status ON frontend_capability_requests(status, updated_at DESC);

      INSERT INTO schema_migrations(version, applied_at) VALUES (16, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationFifteen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE knowledge_resolutions (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('resolved')),
        preferred_value TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        resolved_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(destination_slug, normalized_key)
      );
      CREATE INDEX idx_knowledge_resolutions_destination ON knowledge_resolutions(destination_slug, normalized_key);
      INSERT INTO schema_migrations(version, applied_at) VALUES (15, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationFourteen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE article_visuals ADD COLUMN source_asset_id TEXT REFERENCES source_assets(id);
      ALTER TABLE article_visuals ADD COLUMN source_remote_url TEXT;
      CREATE INDEX idx_article_visuals_source_asset ON article_visuals(source_asset_id);
      INSERT INTO schema_migrations(version, applied_at) VALUES (14, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThirteen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE app_users (
        username TEXT PRIMARY KEY,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        force_password_change INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (13, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwelve(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE topic_candidates ADD COLUMN strategy_version TEXT;
      ALTER TABLE content_briefs ADD COLUMN strategy_version TEXT;
      ALTER TABLE content_briefs ADD COLUMN canonical_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE article_drafts ADD COLUMN strategy_version TEXT;
      ALTER TABLE article_drafts ADD COLUMN content_blocks_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE quality_reviews ADD COLUMN strategy_version TEXT;
      ALTER TABLE wordpress_publications ADD COLUMN strategy_version TEXT;
      ALTER TABLE article_visuals ADD COLUMN strategy_version TEXT;
      ALTER TABLE article_visuals ADD COLUMN image_type TEXT NOT NULL DEFAULT 'illustration';
      ALTER TABLE article_visuals ADD COLUMN image_role TEXT NOT NULL DEFAULT 'support';
      ALTER TABLE article_visuals ADD COLUMN image_subject TEXT NOT NULL DEFAULT '';
      ALTER TABLE article_visuals ADD COLUMN acquisition_strategy TEXT NOT NULL DEFAULT 'generate_illustration';
      ALTER TABLE article_visuals ADD COLUMN factual_image_required INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE content_intake_analyses (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE REFERENCES sources(id) ON DELETE CASCADE,
        strategy_version TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN ('ARTICLE_CANDIDATE','KNOWLEDGE_ONLY','CLAIM_ONLY','CLUSTER_CANDIDATE','RESEARCH_REQUIRED','DUPLICATE','LOW_VALUE','UNSURE')),
        confidence REAL NOT NULL,
        primary_topic TEXT NOT NULL,
        article_potential REAL NOT NULL,
        information_density REAL NOT NULL,
        topic_completeness REAL NOT NULL,
        duplicate_likelihood REAL NOT NULL DEFAULT 0,
        analysis_json TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_content_intake_source ON content_intake_analyses(source_id, updated_at DESC);

      CREATE TABLE content_recommendations (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL UNIQUE REFERENCES content_intake_analyses(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        strategy_version TEXT NOT NULL,
        classification TEXT NOT NULL,
        recommended_action TEXT NOT NULL,
        suggested_content_type TEXT,
        suggested_article_title TEXT,
        reasoning_summary TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved_article','knowledge_only','cluster','research_first','ignored')),
        decision_note TEXT,
        approved_candidate_id TEXT REFERENCES topic_candidates(id),
        decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_content_recommendations_decision ON content_recommendations(decision, updated_at DESC);

      CREATE TABLE content_opportunities (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        topic_key TEXT NOT NULL UNIQUE,
        strategy_version TEXT NOT NULL,
        source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
        recommendation_id TEXT REFERENCES content_recommendations(id) ON DELETE SET NULL,
        candidate_id TEXT REFERENCES topic_candidates(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        content_type TEXT,
        readiness_score REAL NOT NULL,
        coverage_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'recommended' CHECK (status IN ('recommended','approved','knowledge_only','cluster','research_required','ignored','planned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_content_opportunities_destination ON content_opportunities(destination_slug, status, readiness_score DESC);

      INSERT INTO schema_migrations(version, applied_at) VALUES (12, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationEleven(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE article_visuals ADD COLUMN wordpress_media_id INTEGER;
      ALTER TABLE article_visuals ADD COLUMN wordpress_media_url TEXT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (11, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTen(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE article_drafts ADD COLUMN seo_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE article_drafts ADD COLUMN schema_jsonld TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE article_visuals (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES article_drafts(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        placement TEXT NOT NULL,
        purpose TEXT NOT NULL,
        alt_text TEXT NOT NULL,
        caption TEXT NOT NULL DEFAULT '',
        generation_prompt TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL DEFAULT '16:9',
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'generated', 'failed', 'skipped')),
        media_path TEXT,
        media_url TEXT,
        provider TEXT,
        model TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(draft_id, slot)
      );
      CREATE INDEX idx_article_visuals_draft ON article_visuals(draft_id, slot);

      INSERT INTO schema_migrations(version, applied_at) VALUES (10, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationNine(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE runtime_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations(version, applied_at) VALUES (9, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationEight(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE search_console_inventory (
        id TEXT PRIMARY KEY,
        property_url TEXT NOT NULL,
        query TEXT NOT NULL,
        page_url TEXT NOT NULL,
        clicks REAL NOT NULL DEFAULT 0,
        impressions REAL NOT NULL DEFAULT 0,
        ctr REAL NOT NULL DEFAULT 0,
        position REAL NOT NULL DEFAULT 0,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        UNIQUE(property_url, query, page_url)
      );
      CREATE INDEX idx_search_console_query ON search_console_inventory(property_url, impressions DESC, query);

      INSERT INTO schema_migrations(version, applied_at) VALUES (8, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationSeven(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE jobs ADD COLUMN started_at TEXT;
      ALTER TABLE jobs ADD COLUMN completed_at TEXT;
      ALTER TABLE jobs ADD COLUMN queue_latency_ms INTEGER;
      ALTER TABLE jobs ADD COLUMN duration_ms INTEGER;
      CREATE INDEX idx_jobs_completed ON jobs(completed_at, status, type);

      CREATE TABLE exception_notification_state (
        exception_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempted_at TEXT NOT NULL,
        last_sent_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations(version, applied_at) VALUES (7, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationSix(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE maintenance_runs (
        task_key TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'never'
          CHECK (status IN ('never', 'running', 'succeeded', 'failed')),
        last_started_at TEXT,
        last_succeeded_at TEXT,
        last_error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations(version, applied_at) VALUES (6, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationFive(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE knowledge_facts ADD COLUMN freshness_state TEXT NOT NULL DEFAULT 'current'
        CHECK (freshness_state IN ('current', 'time_sensitive', 'stale'));
      ALTER TABLE knowledge_facts ADD COLUMN latest_evidence_at TEXT;
      ALTER TABLE knowledge_facts ADD COLUMN verification_priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (verification_priority IN ('normal', 'review', 'requires_official'));

      ALTER TABLE topic_candidates ADD COLUMN stale_fact_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE topic_candidates ADD COLUMN verification_fact_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE article_drafts ADD COLUMN verification_notes_json TEXT NOT NULL DEFAULT '[]';

      INSERT INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationFour(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE topic_candidates ADD COLUMN suppression_reason TEXT;

      CREATE TABLE wordpress_content_inventory (
        id TEXT PRIMARY KEY,
        site_url TEXT NOT NULL,
        post_id INTEGER NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        post_url TEXT,
        modified_at TEXT,
        synced_at TEXT NOT NULL,
        UNIQUE(site_url, post_id)
      );
      CREATE INDEX idx_wordpress_inventory_site_slug
        ON wordpress_content_inventory(site_url, slug);

      CREATE TABLE integration_sync_state (
        sync_key TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'never'
          CHECK (status IN ('never', 'running', 'succeeded', 'failed')),
        last_started_at TEXT,
        last_succeeded_at TEXT,
        last_error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationThree(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE commercial_offers ADD COLUMN offer_key TEXT;
      ALTER TABLE commercial_offers ADD COLUMN title TEXT NOT NULL DEFAULT '';
      ALTER TABLE commercial_offers ADD COLUMN target_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE commercial_offers ADD COLUMN cta_label TEXT NOT NULL DEFAULT 'View option';
      ALTER TABLE commercial_offers ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE commercial_offers ADD COLUMN price_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE commercial_offers ADD COLUMN valid_until TEXT;
      ALTER TABLE commercial_offers ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE commercial_offers ADD COLUMN source_updated_at TEXT;
      CREATE UNIQUE INDEX idx_commercial_offer_key ON commercial_offers(offer_key);
      CREATE INDEX idx_commercial_offer_destination ON commercial_offers(destination_slug, active, category);

      CREATE TABLE commercial_compositions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES article_drafts(id) ON DELETE CASCADE,
        publishable_body_markdown TEXT NOT NULL,
        slots_json TEXT NOT NULL,
        offer_ids_json TEXT NOT NULL,
        disclosure_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('no_offers', 'composed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationTwo(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE topic_candidates (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        topic_key TEXT NOT NULL UNIQUE,
        proposed_title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        coverage_score REAL NOT NULL,
        evidence_count INTEGER NOT NULL,
        conflict_count INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'brief_queued', 'brief_ready', 'drafted', 'dismissed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE content_briefs ADD COLUMN candidate_id TEXT REFERENCES topic_candidates(id);
      ALTER TABLE content_briefs ADD COLUMN evidence_ledger_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE content_briefs ADD COLUMN model TEXT;
      CREATE UNIQUE INDEX idx_content_briefs_candidate ON content_briefs(candidate_id);

      ALTER TABLE article_drafts ADD COLUMN meta_description TEXT NOT NULL DEFAULT '';
      ALTER TABLE article_drafts ADD COLUMN evidence_ledger_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE article_drafts ADD COLUMN unresolved_conflicts_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE article_drafts ADD COLUMN model TEXT;
      ALTER TABLE article_drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX idx_article_drafts_brief ON article_drafts(brief_id);

      CREATE TABLE quality_reviews (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES article_drafts(id) ON DELETE CASCADE,
        passed INTEGER NOT NULL,
        score REAL NOT NULL,
        checks_json TEXT NOT NULL,
        issues_json TEXT NOT NULL,
        unsupported_claims_json TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE wordpress_publications (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES article_drafts(id) ON DELETE CASCADE,
        site_url TEXT NOT NULL,
        post_id INTEGER,
        post_url TEXT,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'synced', 'failed')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrationOne(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL CHECK (adapter IN ('xiaohongshu')),
        external_id TEXT,
        canonical_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL DEFAULT '',
        author_url TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        captured_at TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        raw_html TEXT NOT NULL,
        raw_payload_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        capture_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'captured',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE source_assets (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video_cover')),
        remote_url TEXT NOT NULL,
        alt_text TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        UNIQUE(source_id, remote_url)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at TEXT NOT NULL,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_ready ON jobs(status, available_at, created_at);

      CREATE TABLE structured_sources (
        source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
        language TEXT NOT NULL,
        summary TEXT NOT NULL,
        destination_name TEXT NOT NULL,
        destination_slug TEXT NOT NULL,
        traveler_fit_json TEXT NOT NULL,
        practical_tips_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        extraction_method TEXT NOT NULL,
        model TEXT,
        extracted_at TEXT NOT NULL
      );

      CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        normalized_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value_text TEXT NOT NULL,
        qualifiers_json TEXT NOT NULL,
        source_quote TEXT NOT NULL,
        confidence REAL NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        created_at TEXT NOT NULL,
        UNIQUE(source_id, normalized_key, value_text)
      );
      CREATE INDEX idx_claims_key ON claims(normalized_key);

      CREATE TABLE source_blueprints (
        source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
        format TEXT NOT NULL,
        hook TEXT NOT NULL,
        angle TEXT NOT NULL,
        sections_json TEXT NOT NULL,
        strengths_json TEXT NOT NULL,
        gaps_json TEXT NOT NULL,
        extracted_at TEXT NOT NULL
      );

      CREATE TABLE destinations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_facts (
        id TEXT PRIMARY KEY,
        destination_id TEXT NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
        normalized_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        consensus_status TEXT NOT NULL CHECK (consensus_status IN ('single_source', 'corroborated', 'conflicted')),
        preferred_value TEXT NOT NULL,
        support_count INTEGER NOT NULL,
        contradiction_count INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(destination_id, normalized_key)
      );

      CREATE TABLE editorial_blueprints (
        id TEXT PRIMARY KEY,
        blueprint_key TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL,
        angle TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        section_patterns_json TEXT NOT NULL,
        strengths_json TEXT NOT NULL,
        gaps_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE content_briefs (
        id TEXT PRIMARY KEY,
        destination_slug TEXT NOT NULL,
        topic TEXT NOT NULL,
        audience TEXT NOT NULL,
        search_intent TEXT NOT NULL,
        plan_json TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE article_drafts (
        id TEXT PRIMARY KEY,
        brief_id TEXT NOT NULL REFERENCES content_briefs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        quality_report_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'review',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Commercial data lives in its own table family and is never read by research aggregation.
      CREATE TABLE commercial_offers (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        category TEXT NOT NULL,
        destination_slug TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
