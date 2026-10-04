"""SELECT-only export of every retained interruption and its recovery context.

No LIMIT or date cutoff. Does not copy the database or export credentials,
runtime settings, prompts, article bodies or provider responses. Can run over
SSH from memory; only the caller writes the JSON report locally.
"""
import datetime
import json
import sqlite3
import sys


def collect(filename):
    db = sqlite3.connect('file:' + filename + '?mode=ro', uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    report = {'version': 'interruption-history-1', 'readOnly': True,
              'collectedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'productionWrites': 0, 'cutoff': None, 'rowLimit': None, 'tables': {}}
    selections = {
        'jobs': 'id type entity_id status attempts max_attempts last_error created_at updated_at started_at completed_at available_at next_eligible_at failure_class last_failure_code failure_details_json failure_execution_kind execution_route production_owner_opportunity_id pipeline_version parent_job_id recovery_run_id locked_by lease_generation lease_expires_at model_role model_routing_revision',
        'production_failure_diagnostics': 'id job_id job_attempt stage error_code execution_kind draft_revision input_hash candidate_hash details_json created_at',
        'model_call_metrics': 'id stage provider model status attempt_status error_code run_id entity_id attempt_number attempts request_kind retry_reason created_at request_started_at request_completed_at input_tokens output_tokens thinking_tokens latency_ms provider_request_ms retry_wait_ms dispatch_state http_status source_run_id article_revision',
        'media_dispatches': 'id scope_key visual_id provider model substage state error_code http_status response_received started_at_ms completed_at_ms created_at updated_at completed_at dispatched_at budget_key',
        'vertex_batch_runs': 'id status state error_code last_error last_output_error error_message created_at updated_at completed_at submitted_at',
        'vertex_batch_items': 'id run_id batch_run_id batch_item_id job_id source_id segment_id status state error_code last_error error_message correlation_warning created_at updated_at completed_at',
        'vertex_batch_output_anomalies': 'id run_id batch_run_id kind reason error_code created_at',
        'media_extraction_batches': 'id source_id capture_version status last_error error_code created_at updated_at',
        'maintenance_runs': 'id task task_key status error last_error started_at last_started_at last_succeeded_at completed_at created_at updated_at',
        'sources': 'id source_kind title status last_error capture_version created_at updated_at',
        'source_segments': 'id source_id capture_version segment_type status created_at updated_at',
        'experience_extraction_runs': 'id source_id capture_version status error_code error last_error created_at updated_at',
        'content_opportunities': 'id title status approved_at candidate_id lifecycle_state processing_state created_at updated_at',
        'content_briefs': 'id candidate_id status last_error created_at updated_at',
        'article_drafts': 'id brief_id title status revision content_hash created_at updated_at',
        'provider_runtime_state': 'provider model consecutive_failures last_success_at last_failure_at last_error_code backoff_until updated_at',
        'pipeline_artifacts': 'id stage entity_id input_hash config_hash status error_class started_at completed_at created_at updated_at',
        'quality_reviews': 'id draft_id passed score issues_json unsupported_claims_json reviewer created_at draft_revision draft_content_hash',
        'article_visuals': 'id draft_id status source_asset_id provider model last_error attempt_count retry_at created_at updated_at',
        'visual_candidates': 'id visual_id draft_id job_id status qa_json last_error_json created_at updated_at promoted_at',
        'wordpress_publications': 'id draft_id status last_error error_code delivery_mode created_at updated_at',
        'integration_sync_state': 'sync_key status last_error last_started_at last_succeeded_at updated_at',
        'exception_notification_state': 'exception_key status attempts last_error updated_at',
        'frontend_contract_state': 'singleton status last_error last_attempt_at last_success_at updated_at',
        'favorites_sync_runs': 'session_id status last_error_json started_at completed_at created_at updated_at',
        'failure_lessons': 'id scope failure_code category normalized_reason source_id opportunity_id failing_stage remediation_rule retry_safe status created_at updated_at',
        'production_rollbacks': 'id opportunity_id failure_lesson_id failing_stage previous_status result_status created_at',
        'production_attempt_archives': 'id opportunity_id failing_job_id failing_stage failure_code created_at',
        'source_assets': 'id source_id capture_version kind extraction_status extraction_error storage_status storage_error durability_status repair_status repair_attempts',
        'knowledge_verification_jobs': 'id destination_slug normalized_key status last_error created_at updated_at completed_at',
        'claim_repair_jobs': 'id claim_id status repair_type last_error created_at updated_at completed_at',
        'source_asset_analyses': 'asset_id source_id capture_version analysis_status provider model last_error analyzed_at created_at updated_at',
        'luna_dispute_reviews': 'id issue_key status request_count last_error created_at updated_at',
        'article_media_uploads': 'id draft_id state asset_id error created_at updated_at',
        'content_operation_history': 'id opportunity_id candidate_id action status created_at',
    }
    try:
        for table, requested in selections.items():
            if table not in tables:
                report['tables'][table] = {'missing': True, 'rows': []}
                continue
            existing = {r[1] for r in db.execute('PRAGMA table_info("' + table + '")')}
            columns = [c for c in requested.split() if c in existing]
            rows = [dict(row) for row in db.execute('SELECT ' + ','.join('"' + c + '"' for c in columns) + ' FROM "' + table + '"')]
            report['tables'][table] = {'columns': columns, 'count': len(rows), 'rows': rows}
        report['schemaVersion'] = db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0]
    finally:
        db.rollback()
        db.close()
    return report


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: audit-interruption-history.py DATABASE')
    print(json.dumps(collect(sys.argv[1]), ensure_ascii=True, separators=(',', ':')))
