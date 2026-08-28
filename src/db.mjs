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
