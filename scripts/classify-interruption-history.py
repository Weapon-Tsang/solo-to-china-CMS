"""Build an exhaustive, traceable ledger from SELECT-only history exports.

Rows are evidence records, not independent incidents; job/diagnostic/request rows
can refer to the same interruption. A later success is contextual evidence, not
proof of an identical-input replay. Unknown causes stay explicitly unreviewed.
"""
import collections
import hashlib
import json
import pathlib
import re
import sys


def family(stage, code, message, table):
    text = f'{code} {message}'
    if table=='production_rollbacks' and not text.strip():return 'historical_rollback'
    if code=='HISTORICAL_PRODUCTION_FAILURE':return 'retention_gap'
    if table=='favorites_sync_runs' and re.search(r'Frame with ID|No tab with id|TAB_CLOSED',text,re.I):return 'capture_tab_interruption'
    if stage in ('pipeline.extraction_concurrency_reduced','pipeline.failed_image_extractions_recovered','pipeline.media_batch_output_limits_recovered','pipeline.owned_jobs_released'):
        return 'operational_control_event'
    if stage=='ai.context_budget_exceeded':return 'model_context_budget'
    if re.search(r'Please sign in|Invalid capture token',text,re.I):return 'authentication_boundary'
    if code in ('MEDIA_CONTEXT_REQUIRED','MEDIA_PURPOSE_CONFLICT') or '重复执行不会产生新配图' in text:return 'editorial_input_boundary'
    if 'Fontconfig error' in text:return 'font_environment_warning'
    if table == 'quality_reviews': return 'content_quality_gate'
    if re.search(r'UNIQUE constraint failed: claims\.', text, re.I): return 'claim_key_collision'
    if code == 'INVALID_OPPORTUNITY_TITLE': return 'title_contract'
    if re.search(r'\b402\b|insufficient balance|payment required', text, re.I): return 'billing_configuration'
    if re.search(r'SUPERSEDED|DUPLICATE_EXPERIENCE|RECOVERY_TARGET_MISMATCH|no longer exists|STALE_PIPELINE_INPUT',text,re.I): return 'superseded_or_stale'
    if re.search(r'REMOTE_MEDIA|AUTHORIZED_SOURCE_IMAGE|authorized source image download',text,re.I): return 'source_original_access'
    if re.search(r'Batch.*no output|did not ingest reliably|known transport key|matching request fingerprint|BATCH_.*(?:CORRELATION|OUTPUT)',text,re.I): return 'batch_correlation'
    if re.search(r'MEDIA_OUTCOME_UNKNOWN|QA_OUTCOME_RECONCILED|WORDPRESS_MEDIA_REFRESH_OUTCOME_UNKNOWN',text,re.I): return 'unknown_external_outcome'
    if re.search(r'MODEL_OUTPUT_LIMIT|token (?:or context )?limit|MAX_TOKENS|input token count exceeds',text,re.I): return 'model_context_budget'
    if re.search(r'SCHEMA_MODE_UNSUPPORTED|invalid argument|\b400\b',text,re.I) and ('contract' not in stage): return 'provider_schema'
    if re.search(r'\b429\b|resource (?:has been )?exhausted|quota|rate.?limit|MEDIA_RATE_WAIT',text,re.I): return 'provider_capacity'
    if re.search(r'\b50[0234]\b|fetch failed|TypeError|TIMEOUT|timed? ?out|aborted|transport failed|PROVIDER_TRANSPORT_FAILED|^23(?:\.0)?\b',text,re.I): return 'provider_transport'
    if re.search(r'database is (?:locked|busy)|SQLITE_BUSY',text,re.I): return 'database_contention'
    if re.search(r'UNIQUE.*frontend_contract_snapshots.checksum',text,re.I): return 'contract_snapshot_collision'
    if re.search(r'MEDIA_DISCOVERY|MEDIA_BUDGET_EXHAUSTED|MEDIA_REQUIRED_MANIFEST_MISSING|no relevant retained',text,re.I): return 'media_selection_or_budget'
    if re.search(r'MEDIA_INCOMPLETE|MEDIA_DELIVERY_INVALID|MEDIA_MANIFEST_MISSING|MEDIA_REQUIRED_',text,re.I): return 'media_delivery_gate'
    if re.search(r'VISUAL.QUALITY|IMAGE_ASPECT|EDITORIAL_CARD_TEXT_OVERFLOW',text,re.I): return 'media_quality_gate'
    if re.search(r'SOURCE_IMAGE_FORMAT_UNSUPPORTED',text,re.I): return 'source_image_format'
    if re.search(r'WORDPRESS_PUBLISHED_REFRESH_SCOPE|different CMS page|DESTINATION_TOPIC_MISMATCH',text,re.I): return 'scope_ownership_gate'
    if re.search(r'DRAFT_|UNTRACEABLE_FACTUAL_BLOCK|INCOMPLETE_EVIDENCE_LEDGER|QA.passed Research Draft|protected evidence value',text,re.I): return 'content_quality_gate'
    if re.search(r'INVALID_MODEL_OUTPUT|EMPTY_MODEL_OUTPUT|no structured output|LOCAL_OUTPUT_INVALID',text,re.I): return 'structured_output'
    if re.search(r'COMMERCIAL_OVERLAY_STALE',text,re.I): return 'commercial_stale_gate'
    if re.search(r'CONTRACT_VERSION_MISMATCH|FRONTEND_CONTRACT|PAGE_SCHEMA|COMPONENT_DATA|FINAL_PAGE_|cms-publish-package-schema',text,re.I): return 'page_contract'
    if re.search(r'\b40[134]\b|AUTH|CREDENTIAL',text,re.I): return 'service_configuration'
    if table == 'visual_candidates': return 'media_quality_gate'
    if table == 'pipeline_artifacts' and not text.strip(): return 'unfinished_artifact'
    if code in ('PROVIDER_REQUEST_FAILED','PRODUCTION_FAILED','ERR_SQLITE_ERROR','execution') and not message: return 'retention_gap'
    if "code: 'ERR_SQLITE_ERROR'" in message:return 'retention_gap'
    if table == 'article_visuals' and not message: return 'media_selection_or_budget'
    if code == 'RETRY_REASON_NOT_RETAINED': return 'retention_gap'
    return 'unclassified'


POLICIES = {
 'claim_key_collision': ('FIXED_THIS_CHANGE','src/repository.mjs','test/entity-resolution.test.mjs'),
 'title_contract': ('FIXED_THIS_CHANGE','src/ai/content-engine.mjs','test/interruption-history.test.mjs'),
 'billing_configuration': ('CAUSE_REQUIRES_ACCOUNT_CHECK_DIAGNOSIS_FIXED','src/services/content-recovery-policy.mjs','test/interruption-history.test.mjs'),
 'superseded_or_stale': ('HISTORICAL_INVALIDATION_NOT_PROVIDER_FAILURE','src/pipeline.mjs','test/production-state-hotfix.test.mjs'),
 'source_original_access': ('RECAPTURE_IF_CURRENT_ORIGINAL_MISSING','src/media-storage.mjs','test/zero-loss-pipeline.test.mjs'),
 'batch_correlation': ('EXISTING_CORRELATION_AND_REALTIME_FALLBACK','src/ai/vertex-gemini-client.mjs','test/vertex-batch-pipeline.test.mjs'),
 'unknown_external_outcome': ('RECONCILE_EXACT_DISPATCH_BEFORE_RETRY','src/media-request-executor.mjs','test/media-request-executor.test.mjs'),
 'model_context_budget': ('BOUNDED_BUDGET_OR_SPLIT_NO_IDENTICAL_LOOP','src/ai/stage-policy.mjs','test/experience-output-budget.test.mjs'),
 'provider_schema': ('EXISTING_COMPATIBILITY_AND_LOCAL_VALIDATION','src/ai/provider-schema.mjs','test/provider-schema.test.mjs'),
 'provider_capacity': ('BOUNDED_BACKOFF_AND_PER_ATTEMPT_QUOTA','src/ai/provider-rate-limiter.mjs','test/architecture-provider.test.mjs'),
 'provider_transport': ('RETRY_OR_RECONCILE_WITHIN_BUDGET','src/ai/provider-schema.mjs','test/architecture-provider.test.mjs'),
 'database_contention': ('EXCLUSIVE_WRITERS_AND_DURABLE_CHECKPOINTS','src/pipeline.mjs','test/reliability-pipeline.test.mjs'),
 'contract_snapshot_collision': ('EXISTING_COMPOSITE_SNAPSHOT_IDENTITY','src/repository.mjs','test/frontend-contract.test.mjs'),
 'media_selection_or_budget': ('QUALITY_AND_SPEND_BOUNDARY_RETAINED','src/pipeline.mjs','test/media-budget-recovery.test.mjs'),
 'media_delivery_gate': ('REQUIRED_MEDIA_GATE_RETAINED','src/media-delivery.mjs','test/media-delivery.test.mjs'),
 'media_quality_gate': ('QUALITY_GATE_RETAINED_NOT_FORCE_PASSED','src/visual-qa.mjs','test/visuals.test.mjs'),
 'source_image_format': ('EXISTING_WEBP_SUPPORT','src/visuals/vertex-imagen.mjs','test/visuals.test.mjs'),
 'scope_ownership_gate': ('OWNER_DESTINATION_PUBLISHED_SCOPE_GUARDS_RETAINED','src/services/content-recovery.mjs','test/production-state-hotfix.test.mjs'),
 'content_quality_gate': ('EVIDENCE_AND_BOUNDED_REPAIR_GUARDS_RETAINED','src/ai/content-engine.mjs','test/content-recovery.test.mjs'),
 'structured_output': ('BOUNDED_REPAIR_AND_SCHEMA_VALIDATION','src/ai/client.mjs','test/model-cost-recovery.test.mjs'),
 'commercial_stale_gate': ('RECOMPOSE_FROM_CURRENT_PAGE','src/repository.mjs','test/commercial.test.mjs'),
 'page_contract': ('SYNC_OR_RECOMPOSE_WITH_CURRENT_CONTRACT','src/frontend-contract.mjs','test/frontend-contract.test.mjs'),
 'service_configuration': ('EXTERNAL_SERVICE_CONFIGURATION_REQUIRED','src/services/content-recovery-policy.mjs','test/content-recovery.test.mjs'),
 'unfinished_artifact': ('INSPECT_CURRENT_JOB_AND_RECEIPT','src/pipeline.mjs','test/pipeline-artifacts.test.mjs'),
 'retention_gap': ('NO_CAUSE_IN_RETAINED_RECORDS_DO_NOT_INFER',None,None),
 'unclassified': ('MANUAL_REVIEW_REQUIRED',None,None),
 'operational_control_event': ('RECOVERY_OR_THROTTLE_SIGNAL_NOT_NEW_FAILURE','src/pipeline.mjs','test/reliability-pipeline.test.mjs'),
 'authentication_boundary': ('LOGIN_OR_CAPTURE_TOKEN_REJECTED_NOT_PRODUCTION_GENERATION','src/server.mjs','test/server.test.mjs'),
 'editorial_input_boundary': ('MEDIA_RELEVANCE_AND_SLOT_GUARDS_RETAINED','src/repository.mjs','test/visual-planning.test.mjs'),
 'font_environment_warning': ('HISTORICAL_FONT_WARNING_NO_CURRENT_FATAL_EXIT_PROVEN',None,None),
 'capture_tab_interruption': ('EXISTING_FRAME_RETRY_AND_EXPLICIT_PAUSE_RESUME','extension/background.js','test/extension-background-recovery.test.mjs'),
 'historical_rollback': ('RECORDED_ROLLBACK_NOT_NEW_FAILURE','src/repository.mjs','test/content-recovery.test.mjs'),
}


def main(root):
    live=json.loads((root/'live-history.json').read_text(encoding='utf8'))
    retained=json.loads((root/'retained-history.json').read_text(encoding='utf8'))
    jobs={row['id']:row for row in live['tables']['jobs']['rows']}
    successes=collections.defaultdict(list)
    for row in jobs.values():
        if row['status']=='succeeded': successes[(row['type'],row['entity_id'])].append(row)
    records={}
    for origin,data in [('retained',retained),('live',live)]:
        for table,entry in data['tables'].items():
            for row in entry['rows']:
                selected=(table=='jobs' and (row['status']=='failed' or row.get('last_error') or row.get('last_failure_code'))
                  or table=='production_failure_diagnostics'
                  or table=='model_call_metrics' and (row['status']=='failed' or row.get('attempt_status')=='failed')
                  or table in ('vertex_batch_runs','vertex_batch_items','article_visuals','experience_extraction_runs','media_extraction_batches','maintenance_runs') and (row.get('status')=='failed' or row.get('last_error'))
                  or table=='vertex_batch_output_anomalies'
                  or table=='media_dispatches' and row['state'] in ('failed','outcome_unknown','dispatch_started')
                  or table=='pipeline_artifacts' and row['status'] in ('failed','started')
                  or table=='quality_reviews' and row['passed']==0
                  or table=='visual_candidates' and row['status'] not in ('promoted','passed')
                  or table in ('failure_lessons','production_rollbacks')
                  or table=='production_attempt_archives' and row.get('failure_code')
                  or table in ('wordpress_publications','integration_sync_state','exception_notification_state','frontend_contract_state',
                    'favorites_sync_runs','source_assets','knowledge_verification_jobs','claim_repair_jobs','source_asset_analyses',
                    'luna_dispute_reviews','article_media_uploads','content_operation_history','sources','content_briefs')
                    and (row.get('status') in ('failed','error','exception') or row.get('last_error') or row.get('error')
                      or row.get('extraction_error') or row.get('storage_error') or row.get('last_error_json') not in (None,'','{}')))
                if not selected: continue
                detail=json.loads(row.get('details_json') or row.get('failure_details_json') or row.get('last_error_json') or '{}')
                job_id=row.get('job_id') or row.get('failing_job_id') or (row.get('run_id') if table=='model_call_metrics' else row.get('id') if table=='jobs' else None)
                job=jobs.get(job_id,{})
                stage=row.get('type') or row.get('stage') or row.get('failing_stage') or row.get('substage') or job.get('type') or table
                code=str(row.get('last_failure_code') or row.get('error_code') or row.get('failure_code') or row.get('error_class') or detail.get('code') or '')
                message=row.get('last_error') or row.get('reason') or row.get('normalized_reason') or detail.get('message') or row.get('issues_json') or row.get('error') or row.get('error_message') or row.get('last_output_error') or row.get('extraction_error') or row.get('storage_error') or ''
                if not isinstance(message,str):message=json.dumps(message,ensure_ascii=False)
                at=row.get('created_at') if table!='jobs' else row.get('updated_at')
                at=at or row.get('completed_at') or ''
                identity=str(row.get('id') or ':'.join(str(row.get(k,'')) for k in ('run_id','job_id','batch_item_id','task_key','asset_id','session_id','sync_key','exception_key','singleton')))
                key=hashlib.sha256(json.dumps([table,identity,code,message],ensure_ascii=True).encode()).hexdigest()
                group=family(stage,code,(('HTTP '+str(row['http_status'])+' ') if row.get('http_status') else '')+message,table)
                later=[x for x in successes.get((job.get('type'),job.get('entity_id')),[]) if x['updated_at']>=at]
                policy,source,test=POLICIES[group]
                records[key]={'recordId':identity,'table':table,'origin':origin,'stage':stage,'code':code,'message':message,'at':at,
                  'family':group,'assessment':policy,'source':source,'regression':test,'jobId':job_id,
                  'currentJobStatus':job.get('status'),'ownerId':job.get('production_owner_opportunity_id') or row.get('opportunity_id'),
                  'laterSuccessfulSameStageJob':min(later,key=lambda x:x['updated_at'])['id'] if later else None}
    runtime=json.loads((root/'runtime-history.json').read_text(encoding='utf8')) if (root/'runtime-history.json').exists() else {'containers':[]}
    for container in runtime['containers']:
        entries=[*container['events'],*({'event':'unstructured','error':{'message':message},'occurrences':n}
          for message,n in container['unstructuredErrors'].items())]
        for index,row in enumerate(entries):
            error=row.get('error') or {};stage=row.get('jobType') or row.get('event') or 'runtime'
            code=str(error.get('code') or '');message=error.get('message') or ''
            group=family(stage,code,message,'runtime_log')
            if row.get('event') in ('pipeline.extraction_concurrency_reduced','pipeline.failed_image_extractions_recovered','pipeline.media_batch_output_limits_recovered','pipeline.owned_jobs_released'):
                group='operational_control_event'
            policy,source,test=POLICIES[group];job=jobs.get(row.get('jobId'),{})
            record_id=f"{container['name']}:{index}"
            records[record_id]={'recordId':record_id,'table':'runtime_log','origin':'runtime','stage':stage,'code':code,
              'message':message,'at':row.get('timestamp'),'family':group,'assessment':policy,'source':source,'regression':test,
              'jobId':row.get('jobId'),'currentJobStatus':job.get('status'),'ownerId':job.get('production_owner_opportunity_id'),
              'event':row.get('event'),'occurrences':row.get('occurrences',1)}
    linked={r['jobId'] for r in records.values() if r['jobId']}
    gaps=[x for x in jobs.values() if x['attempts']>1 and x['id'] not in linked]
    summary={'version':'interruption-ledger-1','liveCollectedAt':live['collectedAt'],
      'coverage':{k:v.get('count') for k,v in live['tables'].items()},'evidenceRecords':len(records),
      'recordCountsByTable':dict(collections.Counter(r['table'] for r in records.values())),
      'families':dict(collections.Counter(r['family'] for r in records.values())),
      'unclassified':sum(r['family']=='unclassified' for r in records.values()),
      'multipleAttemptJobsWithoutRetainedFailureCause':len(gaps),'multipleAttemptJobIds':[x['id'] for x in gaps],
      'currentActiveJobs':sum(j['status'] in ('queued','running') for j in jobs.values()),
      'currentDraftStates':dict(collections.Counter(r['status'] for r in live['tables']['article_drafts']['rows'])),
      'runtime':{'containers':len(runtime['containers']),'lines':sum(c['lineCount'] for c in runtime['containers']),
        'diagnostics':sum(len(c['events']) for c in runtime['containers']),
        'oomKilledContainers':sum(c['state']['OOMKilled'] for c in runtime['containers'])},
      'limitations':['Records overlap; counts are not independent incident totals.',
        'Deleted or rotated logs and overwritten retry causes cannot be reconstructed.',
        'Multiple attempts can include deliberate yields or Batch polling; they do not prove a failure.',
        'Later same-stage success is not proof of identical-input recovery.'],
      'productionWrites':0}
    with (root/'history-ledger.jsonl').open('w',encoding='utf8') as stream:
        for record in records.values():stream.write(json.dumps(record,ensure_ascii=False)+'\n')
    (root/'history-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
    signatures={}
    for row in records.values():
        signature=(row['stage'],row['code'],row['family'],row['message'])
        signatures.setdefault(signature,{**row,'count':0,'recordIds':[]})
        signatures[signature]['count']+=1;signatures[signature]['recordIds'].append(row['recordId'])
    (root/'signature-review.json').write_text(json.dumps(list(signatures.values()),ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({k:v for k,v in summary.items() if k!='multipleAttemptJobIds'},ensure_ascii=True))


if __name__=='__main__':main(pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'output/interruption-history-20261004'))
