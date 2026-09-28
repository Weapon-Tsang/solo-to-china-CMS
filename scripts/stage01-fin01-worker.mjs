// Stage 01 local acceptance harness. It never loads .env or calls a provider.
// The only stubs are the AI boundary methods of the real application Worker.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { createApplication } from '../src/server.mjs';
import { markLocalDataRoot } from '../src/local-runtime.mjs';
import { createMediaRequestExecutor } from '../src/media-request-executor.mjs';

const [mode, root] = process.argv.slice(2);
if (!['prepare', 'prepare-v12', 'seed', 'worker', 'api', 'inspect'].includes(mode) || !root || !path.isAbsolute(root)) {
  throw new Error('Usage: node scripts/stage01-fin01-worker.mjs prepare|prepare-v12|seed|worker|api|inspect ABSOLUTE_DATA_ROOT');
}
const databasePath = path.join(root, 'solo-to-china.sqlite');
const base = { CMS_RUN_MODE: 'development', CMS_DATA_ROOT: root, DATABASE_PATH: databasePath,
  MAINTENANCE_ENABLED: 'false', NODE_TEST_CONTEXT: '1', LOG_LEVEL: 'info',
  KIMI_API_KEY: 'stage01-loopback-fixture', KIMI_BASE_URL: 'http://127.0.0.1:9/v1',
  VERTEX_AI_ACCESS_TOKEN: '', GEMINI_API_KEY: '', OPENAI_API_KEY: '',
  DEEPSEEK_API_KEY: '', WORDPRESS_SITE_URL: '', VERTEX_AI_BATCH_ENABLED: 'false',
  AI_CONCURRENCY_MODE: 'fixed', AI_CONCURRENCY_INITIAL: '1', AI_CONCURRENCY_MAX: '1',
  EXTRACT_PROCESS_ISOLATION_ENABLED: 'false' };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

if (mode === 'prepare' || mode === 'prepare-v12') {
  if (fs.existsSync(root)) throw new Error('prepare requires a new, unused directory');
  markLocalDataRoot(loadConfig(base), 'development');
  const db = openDatabase(databasePath);
  try {
    const config = loadConfig(base);
    const repository = new Repository(db, { sourceUploadsDir: config.manualSources.uploadDir });
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const image = Buffer.from(imageBase64, 'base64');
    const text = 'Take Metro Line 2 to the riverside entrance. Follow the signed walking path from the station to the entrance. This fixture describes a complete visitor route.';
    const saved = repository.saveCapture(normalizeXiaohongshuCapture({
      url: `https://www.xiaohongshu.com/explore/a${crypto.randomUUID().replaceAll('-', '')}`,
      title: 'Riverside entrance route', text,
      images: [{ url: 'https://example.test/decorative-divider.png', mimeType: 'image/png',
        originalSha256: sha(image), originalDataUrl: `data:image/png;base64,${imageBase64}`,
        alt: 'decorative logo divider', nearbyText: 'Decorative divider; no visitor fact is asserted.',
        captionText: 'Decorative divider' }],
    }));
    const asset = db.prepare('SELECT id,local_path,stored_sha256,original_bytes_status FROM source_assets WHERE source_id=?').get(saved.id);
    const jobs = db.prepare('SELECT id,type,status FROM jobs WHERE entity_id=? ORDER BY created_at').all(saved.id);
    let reviewSourceId = null;
    let unknownDispatchId = null;
    let unknownBudget = null;
    const systemFailureJobIds = [];
    if (mode === 'prepare-v12') {
      const reviewText = 'STAGE01_REVIEW_FIXTURE. This source says that entrance details matter, but intentionally omits the concrete entrance and walking route needed for publication.';
      const review = repository.saveCapture(normalizeXiaohongshuCapture({
        url: `https://www.xiaohongshu.com/explore/b${crypto.randomUUID().replaceAll('-', '')}`,
        title: 'Missing entrance details review fixture', text: reviewText, images: [],
      }));
      reviewSourceId = review.id;
      for (let i = 0; i < 55; i++) {
        const jobId = repository.enqueue('rebuild_topics', `stage01-v12-health-${String(i + 1).padStart(2, '0')}`,
          { dedupeKey: `stage01-v12-health-${i + 1}` });
        db.prepare(`UPDATE jobs SET status='failed',last_error='Fixture provider authentication failure',
          last_failure_code='AI_PROVIDER_AUTH',updated_at=? WHERE id=?`)
          .run(new Date(Date.now() - i * 1000).toISOString(), jobId);
        systemFailureJobIds.push(jobId);
      }
      const media = createMediaRequestExecutor(db, { rpm:1, maxDispatches:1,
        clock:() => Date.parse('2026-09-27T08:00:00.000Z') });
      const params = { provider:'vertex', model:'fixture-image-model', accountScope:'stage01-v12',
        visualId:'stage01-v12-unknown-visual', substage:'analyze_source_image' };
      const permit = media.acquire(params);
      unknownDispatchId = permit.token;
      permit.finish({ error:{code:'NETWORK_TIMEOUT'}, responseReceived:false });
      unknownBudget = media.budget(params);
    }
    const manifest = { format: mode === 'prepare-v12' ? 'stage01-fin01-fixture-1.2' : 'stage01-fin01-fixture-1', createdAt: new Date().toISOString(),
      sourceId: saved.id, sourceTextSha256: sha(text), imageSha256: sha(image), asset,
      reviewSourceId, unknownDispatchId, unknownBudget, systemFailureJobIds,
      initialJobs: jobs, databasePath, networkBoundary: 'in-process AI methods; dummy key points at closed loopback port' };
    fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(manifest));
  } finally { db.close(); }
} else if (mode === 'seed') {
  const count = Math.max(1, Math.min(300, Number(process.argv[4] || 100)));
  const db = openDatabase(databasePath);
  try {
    const repository = new Repository(db, { sourceUploadsDir: loadConfig(base).manualSources.uploadDir });
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const image = Buffer.from(imageBase64, 'base64');
    const ids = [];
    for (let i = 0; i < count; i++) {
      const saved = repository.saveCapture(normalizeXiaohongshuCapture({
        url: `https://www.xiaohongshu.com/explore/${crypto.randomBytes(12).toString('hex')}`,
        title: `Riverside entrance load ${i + 1}`,
        text: 'Take Metro Line 2 to the riverside entrance. Follow the signed walking path from the station to the entrance. This selected fixture describes a complete visitor route.',
        images: [{ url: `https://example.test/decorative-divider-${i}.png`, mimeType: 'image/png',
          originalSha256: sha(image), originalDataUrl: `data:image/png;base64,${imageBase64}`,
          alt: 'decorative logo divider', nearbyText: 'Decorative divider; no visitor fact is asserted.' }],
      }));
      ids.push(saved.id);
    }
    const report = { at: new Date().toISOString(), root, count, sourceIds: ids,
      queued: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'").get().n };
    fs.writeFileSync(path.join(root, 'seed.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ at: report.at, count, queued: report.queued, firstSourceId: ids[0] }));
  } finally { db.close(); }
} else if (mode === 'inspect') {
  const db = openDatabase(databasePath, { readOnly: true });
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
    const jobs = db.prepare('SELECT id,type,entity_id,status,attempts,created_at,updated_at,last_failure_code FROM jobs ORDER BY created_at,id').all();
    const source = db.prepare('SELECT id,status,last_error FROM sources WHERE id=?').get(manifest.sourceId);
    const reviewSource = manifest.reviewSourceId
      ? db.prepare('SELECT id,status,last_error FROM sources WHERE id=?').get(manifest.reviewSourceId) : null;
    const coverage = db.prepare('SELECT segment_id,status,publication_usability,claim_count FROM extraction_coverage').all();
    const unknownDispatches = db.prepare(`SELECT id,visual_id,substage,state,error_code,started_at_ms,completed_at_ms
      FROM media_dispatches WHERE state IN ('dispatch_started','outcome_unknown') ORDER BY created_at,id`).all();
    const report = { at: new Date().toISOString(), source, reviewSource, jobs, coverage,
      claims: db.prepare('SELECT id,source_id,normalized_key,value_text,source_quote FROM claims WHERE source_id=?').all(manifest.sourceId),
      artifacts: db.prepare('SELECT * FROM pipeline_artifacts').all(),
      modelCalls: db.prepare('SELECT COUNT(*) n FROM model_call_metrics').get().n,
      mediaDispatches: db.prepare('SELECT COUNT(*) n FROM media_dispatches').get().n,
      unknownDispatches,
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length };
    console.log(JSON.stringify(report, null, 2));
  } finally { db.close(); }
} else {
  const role = mode === 'api' ? 'api' : 'worker';
  const config = loadConfig({ ...base, CMS_PROCESS_ROLE: role, HOST: '127.0.0.1', PORT: '0' });
  const app = createApplication(config);
  if (mode === 'worker') {
    // Only the provider boundary is replaced. Pipeline, Repository, leases,
    // checkpoints, transactions, and queue scheduling are the application code.
    const router = app.pipeline.extractor;
    router.extract = async input => {
      const assets = input.assets || [];
      const text = String(input.raw_text || '').trim();
      const image = assets.length > 0;
      const reviewFixture = text.includes('STAGE01_REVIEW_FIXTURE');
      const quote = 'Take Metro Line 2 to the riverside entrance.';
      const result = { source: { language: 'en', summary: 'A visitor route to the riverside entrance.',
        destination_name: 'Fixture City', destination_slug: 'fixture-city', traveler_fit: ['solo'],
        practical_tips: [], warnings: [], confidence: 0.9 },
        claims: image || reviewFixture ? [] : [{ key: 'fixture.route.metro', subject: 'Riverside entrance',
          predicate: 'transport route', value: 'Metro Line 2', qualifiers: [], confidence: 0.9,
          source_quote: text.includes(quote) ? quote : text.slice(0, 70) }],
        blueprint: { format: 'guide', hook: 'Find the entrance', angle: 'first visit', sections: [], strengths: [], gaps: [] } };
      const manifest = { version: 1, expectedModality: image ? 'image' : 'text',
        receivedModality: image ? 'image' : 'text', provider: 'stage01-local-boundary',
        model: 'fixture', capabilities: { text: true, image: true, video: false, batch: false },
        assets: assets.map(asset => ({ assetId: asset.id, kind: 'image', status: 'submitted' })) };
      fs.appendFileSync(path.join(root, 'boundary.jsonl'), JSON.stringify({ at: new Date().toISOString(),
        pid: process.pid, method: 'extract', image, reviewFixture, assetIds: assets.map(asset => asset.id), inputSha256: sha(text) }) + '\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      return { method: 'stage01-local-boundary', model: 'fixture', result, inputManifest: manifest };
    };
    router.auditCoverage = async input => {
      fs.appendFileSync(path.join(root, 'boundary.jsonl'), JSON.stringify({ at: new Date().toISOString(),
        pid: process.pid, method: 'auditCoverage', segmentId: input.segment?.id }) + '\n');
      const raw = String(input.segment?.raw_text || input.segment?.text || '');
      const reviewFixture = raw.includes('STAGE01_REVIEW_FIXTURE');
      return { model: 'fixture', output: { uncovered_spans: reviewFixture ? [{
        locator:'fixture:missing-entrance-route', reason:'Concrete entrance and walking route are absent.', importance:'material'
      }] : [], modality: { expected: 'text', received: 'text', attempted: 0 } } };
    };
    Object.defineProperty(router, 'enabled', { get: () => true });
    router.enabledFor = () => true;
    router.configFor = () => ({ provider: 'gemini', sourceUploadsDir: config.manualSources.uploadDir });
    router.analyzeExperience = async () => ({ model: 'fixture', output: { blocks: [] } });
    router.resolveEntities = async () => ({ model: 'fixture', output: { entities: [], claim_updates: [], candidates: [] } });
    router.analyzeIntake = async () => ({ model: 'fixture', output: {
      classification: 'KNOWLEDGE_ONLY', confidence: 0.9, primary_topic: 'Riverside entrance route',
      article_potential: 20, information_density: 40, topic_completeness: 50,
      duplicate_likelihood: 0, recommended_action: 'ADD_TO_KNOWLEDGE',
      reasoning_summary: 'The single supported route fact is useful as knowledge; no article is proposed.' } });
    router.analyzeBlueprint = async () => ({ model: 'fixture', output: {
      format: 'guide', hook: 'Find the entrance', angle: 'first visit', sections: [], strengths: [], gaps: [] } });
    app.startWorker();
    console.log(JSON.stringify({ event: 'stage01_worker_ready', pid: process.pid, root }));
    const stopTimer = setInterval(async () => {
      if (!fs.existsSync(path.join(root, '.fin01-stop'))) return;
      clearInterval(stopTimer);
      console.log(JSON.stringify({ event: 'stage01_worker_stop_requested', pid: process.pid,
        at: new Date().toISOString() }));
      await app.stop();
      process.exit(0);
    }, 100);
    if (process.argv.includes('--stop-after-first-artifact')) {
      const timer = setInterval(async () => {
        const first = app.repository.db.prepare(`SELECT id,stage,entity_id,input_hash,output_hash,completed_at
          FROM pipeline_artifacts WHERE status='succeeded' ORDER BY completed_at LIMIT 1`).get();
        if (!first) return;
        clearInterval(timer);
        fs.writeFileSync(path.join(root, 'interruption.json'), JSON.stringify({
          at: new Date().toISOString(), pid: process.pid, firstArtifact: first,
          boundaryCalls: fs.existsSync(path.join(root, 'boundary.jsonl'))
            ? fs.readFileSync(path.join(root, 'boundary.jsonl'), 'utf8').trim().split('\n').length : 0,
        }, null, 2), { flag: 'wx' });
        await app.stop();
        process.exit(0);
      }, 25);
    }
    if (process.argv.includes('--stop-when-drained')) {
      let emptyChecks = 0;
      const timer = setInterval(async () => {
        const active = app.repository.db.prepare(`SELECT COUNT(*) AS n FROM jobs
          WHERE status IN ('queued','running')`).get().n;
        emptyChecks = active === 0 ? emptyChecks + 1 : 0;
        if (emptyChecks < 3) return;
        clearInterval(timer);
        console.log(JSON.stringify({ event: 'stage01_worker_drained', pid: process.pid,
          at: new Date().toISOString(), active }));
        await app.stop();
        process.exit(0);
      }, 250);
    }
  } else {
    await app.start();
    console.log(JSON.stringify({ event: 'stage01_api_ready', pid: process.pid,
      url: `http://127.0.0.1:${app.server.address().port}`, root }));
  }
  const stop = async () => { await app.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
