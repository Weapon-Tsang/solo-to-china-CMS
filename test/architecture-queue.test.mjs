import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { ProviderRequestError } from '../src/ai/provider-schema.mjs';

test('an aged database rebuild drains running work without admitting an endless ingest stream', t => {
  const { repository, db } = repositoryFixture(t);
  const first = repository.enqueue('preflight_source', 'active', { workloadClass: 'normal_ingest' });
  const active = repository.claimJob();
  assert.equal(active.id, first);
  const heavy = repository.enqueue('rebuild_knowledge', 'chongqing');
  repository.enqueue('preflight_source', 'next', { workloadClass: 'normal_ingest' });
  db.prepare("UPDATE jobs SET created_at='2000-01-01' WHERE id=?").run(heavy);
  assert.equal(repository.claimJob(), null, 'stop filling freed slots until the exclusive writer can run');
  assert.equal(repository.claimJob({ workloadClass: 'production' }), null);
  repository.completeJob(active.id, active.locked_by, active.lease_generation);
  assert.equal(repository.claimJob().id, heavy);
  assert.equal(repository.claimJob(), null, 'writer exclusivity is preserved');
});

test('future and newly queued rebuilds do not unnecessarily stop ingest', t => {
  const { repository, db } = repositoryFixture(t);
  repository.enqueue('preflight_source', 'active');
  repository.claimJob();
  const heavy = repository.enqueue('rebuild_knowledge', 'chongqing');
  const next = repository.enqueue('preflight_source', 'next');
  assert.equal(repository.claimJob().id, next);
  db.prepare("UPDATE jobs SET status='succeeded' WHERE type='preflight_source'").run();
  db.prepare("UPDATE jobs SET created_at='2000-01-01',available_at='2100-01-01' WHERE id=?").run(heavy);
  const later = repository.enqueue('preflight_source', 'later');
  assert.equal(repository.claimJob().id, later);
});

test('provider cooldown uses the frozen canonical route and cannot be shortened by a second failure', t => {
  const { repository, db } = repositoryFixture(t);
  const first = repository.enqueue('compose_opportunity_titles', 'chongqing');
  const active = repository.claimJob();
  assert.equal(active.id, first);
  repository.failJob(active, new ProviderRequestError('Vertex Gemini', 429, 'quota', { retryAfter: '120' }));
  const cooldown = db.prepare("SELECT backoff_until FROM provider_runtime_state WHERE provider='vertex'").get();
  assert.ok(cooldown, 'scheduler and failure handler must share the same provider identity');
  repository.enqueue('compose_opportunity_titles', 'beijing');
  assert.equal(repository.claimJob(), null, 'do not dispatch another writing request during provider cooldown');
  assert.equal(db.prepare("SELECT count(*) n FROM provider_runtime_state WHERE provider='Vertex Gemini'").get().n, 0);
  const later = repository.enqueue('compose_opportunity_titles', 'shanghai');
  db.prepare("UPDATE jobs SET status='running',attempts=1,locked_by=?,lease_generation=1,lease_expires_at='2100-01-01' WHERE id=?")
    .run(repository.workerId, later);
  const longest = '2100-01-01T00:00:00.000Z';
  db.prepare("UPDATE provider_runtime_state SET backoff_until=? WHERE provider='vertex'").run(longest);
  repository.failJob(db.prepare('SELECT * FROM jobs WHERE id=?').get(later),
    new ProviderRequestError('Vertex Gemini', 429, 'quota', { retryAfter: '1' }));
  assert.equal(db.prepare("SELECT backoff_until FROM provider_runtime_state WHERE provider='vertex'").get().backoff_until, longest);
});

test('a stale worker cannot publish failure side effects after its lease is replaced', t => {
  const {repository, db} = repositoryFixture(t);
  repository.enqueue('compose_opportunity_titles', 'beijing');
  const stale = repository.claimJob();
  db.prepare("UPDATE jobs SET lease_generation=lease_generation+1,locked_by='replacement' WHERE id=?").run(stale.id);
  const before = db.prepare('SELECT * FROM provider_runtime_state').all();
  assert.equal(repository.failJob(stale, new ProviderRequestError('Vertex Gemini', 429, 'quota')), false);
  assert.deepEqual(db.prepare('SELECT * FROM provider_runtime_state').all(), before);
  assert.equal(repository.providerPressureStreak, 0);
  assert.equal(repository.providerBackoffUntil, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM production_failure_diagnostics').get().n, 0);
});

test('cached output is recorded for cost visibility without claiming that an unhealthy provider recovered', t => {
  const {repository, db} = repositoryFixture(t);
  repository.recordModelCall({stage:'generate_draft',provider:'vertex',model:'test',status:'failed',attempts:1,errorCode:'429'});
  const before = db.prepare("SELECT * FROM provider_runtime_state WHERE provider='vertex'").get();
  repository.recordModelCall({stage:'generate_draft',provider:'vertex',model:'test',status:'succeeded',attempts:0,
    requestKind:'cache_hit',cacheHit:true,costUsd:0});
  assert.deepEqual(db.prepare("SELECT * FROM provider_runtime_state WHERE provider='vertex'").get(), before);
  assert.equal(db.prepare("SELECT count(*) n FROM model_call_metrics WHERE cache_hit=1").get().n, 1);
});
