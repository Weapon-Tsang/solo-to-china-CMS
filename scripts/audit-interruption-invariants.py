"""Explore current gaps from read-only exports, without scheduling recovery."""
import collections
import json
import pathlib
import sys


def audit(root):
    history = json.loads((root / 'live-history.json').read_text(encoding='utf8'))
    tables = history['tables']
    rows = lambda name: tables[name]['rows']
    jobs = rows('jobs')
    active = [j for j in jobs if j['status'] in ('queued', 'running')]
    sources = {s['id']: s for s in rows('sources')}
    opportunities = {o['id']: o for o in rows('content_opportunities')}
    segments = {s['id']: s for s in rows('source_segments')}
    states = json.loads((root / 'live-production-configured.json').read_text(encoding='utf8'))
    missing = []
    for source in sources.values():
        if source['status'] != 'processed':
            continue
        if any(r['source_id'] == source['id'] and r['capture_version'] == source['capture_version']
               and r['status'] == 'succeeded' for r in rows('experience_extraction_runs')):
            continue
        history_jobs = sorted((j for j in jobs if j['entity_id'] == source['id']
                               and j['type'] == 'extract_source_experience'), key=lambda j: j['updated_at'])
        missing.append({'sourceId': source['id'], 'title': source['title'], 'captureVersion': source['capture_version'],
                        'latestJob': history_jobs[-1] if history_jobs else None})
    groups = collections.defaultdict(list)
    for job in active:
        groups[(job['type'], job['entity_id'], job.get('production_owner_opportunity_id'))].append(job['id'])
    unfinished = []
    for artifact in rows('pipeline_artifacts'):
        if artifact['status'] != 'started':
            continue
        same = sorted((j for j in jobs if j['entity_id'] == artifact['entity_id'] and j['type'] == artifact['stage']),
                      key=lambda j: j['updated_at'])
        latest = same[-1] if same else None
        unfinished.append({'artifactId': artifact['id'], 'stage': artifact['stage'], 'entityId': artifact['entity_id'],
                           'latestJobId': latest['id'] if latest else None,
                           'latestJobStatus': latest['status'] if latest else None,
                           'latestFailureCode': latest.get('last_failure_code') if latest else None})
    report = {
        'version': 'interruption-invariants-1', 'baselineCollectedAt': history['collectedAt'], 'productionWrites': 0,
        'activeJobs': len(active),
        'sourceStates': dict(collections.Counter(s['status'] for s in sources.values())),
        'processingSourcesWithoutActiveJob': [s['id'] for s in sources.values() if s['status'] == 'processing'
            and not any(j['entity_id'] == s['id'] or segments.get(j['entity_id'], {}).get('source_id') == s['id'] for j in active)],
        'activeOrphanSegmentJobs': [j['id'] for j in active if j['type'] in
            ('extract_segment_claims', 'audit_segment_coverage', 'retry_segment_extraction') and j['entity_id'] not in segments],
        'unapprovedActiveProductionJobs': [j['id'] for j in active if j.get('production_owner_opportunity_id')
            and not opportunities.get(j['production_owner_opportunity_id'], {}).get('approved_at')],
        'duplicateActiveJobGroups': [ids for ids in groups.values() if len(ids) > 1],
        'productionLifecycleCounts': dict(collections.Counter(s['lifecycle'] for s in states)),
        'duplicateProductionOwners': [oid for oid, count in collections.Counter(s['opportunity_id'] for s in states).items() if count > 1],
        'currentContentBlockers': [s for s in states if s['lifecycle'] == 'needs_attention'],
        'processedSourcesMissingCurrentExperience': missing,
        'unfinishedArtifactMarkers': unfinished,
        'unsettledMediaDispatches': [d for d in rows('media_dispatches') if d['state'] in ('outcome_unknown', 'dispatch_started')],
        'latestTitleFailuresWithoutLaterSuccess': [j['id'] for j in jobs if j.get('last_failure_code') == 'INVALID_OPPORTUNITY_TITLE'
            and not any(s['type'] == j['type'] and s['entity_id'] == j['entity_id'] and s['status'] == 'succeeded'
                        and s['updated_at'] > j['updated_at'] for s in jobs)],
        'limitations': ['This is a state audit, not an AI regeneration or content-quality verdict.',
                       'No automatic production recovery is performed.',
                       'Historical failed and superseded artifacts are retained, not silently removed.'],
    }
    report['status'] = 'ISSUES FOUND' if (missing or report['currentContentBlockers']
        or report['unsettledMediaDispatches'] or report['latestTitleFailuresWithoutLaterSuccess']) else 'PASS'
    (root / 'exploratory-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({k: len(v) if isinstance(v, list) else v for k, v in report.items() if k != 'limitations'}, ensure_ascii=True))


if __name__ == '__main__':
    audit(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'output/interruption-history-20261004'))
