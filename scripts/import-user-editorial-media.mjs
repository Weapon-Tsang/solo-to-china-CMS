// Guarded, media-only import for operator-supplied originals. Run --plan first,
// rehearse --apply on a production-copy work DB, then re-plan the live DB.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { Repository } from '../src/repository.mjs';
import { transaction } from '../src/db.mjs';
import { auditSourcePhoto, closeLocalPhotoAudit } from '../src/local-photo-audit.mjs';
import { id, now } from '../src/utils.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.database || !args.imagesRoot || !args.sourceRoot || !args.manifest) {
  throw new Error('Pass --database, --images-root, --source-root and --manifest.');
}
if (!['plan', 'apply'].includes(args.mode)) throw new Error('--mode must be plan or apply.');
const livePath = '/var/lib/solo-to-china/solo-to-china.sqlite';
const databasePath = path.resolve(args.database);
const isLive = databasePath === livePath;
if (args.mode === 'apply' && !isLive && !/work/i.test(path.basename(databasePath))) {
  throw new Error('Apply requires an explicit disposable work DB or the exact live production DB path.');
}
if (args.mode === 'apply' && isLive && args.production !== 'EDITORIAL_MEDIA_PRODUCTION') {
  throw new Error('Live apply requires --production EDITORIAL_MEDIA_PRODUCTION.');
}
const manifestBytes = fs.readFileSync(args.manifest);
const manifest = JSON.parse(manifestBytes);
if (manifest.version !== 1 || manifest.articles?.length !== 3 || manifest.images?.length !== 8) {
  throw new Error('Unexpected editorial manifest shape.');
}
const requestedArticleIds = args.articleIds.length ? new Set(args.articleIds) : null;
const selectedArticles = manifest.articles.filter((article) => !requestedArticleIds || requestedArticleIds.has(article.draftId));
if (!selectedArticles.length || (requestedArticleIds && selectedArticles.length !== requestedArticleIds.size)) {
  throw new Error('Article selection does not match the manifest.');
}
const listed = selectedArticles.flatMap((article) => article.images);
const selectedAccounts = new Set(manifest.images
  .filter((image) => listed.includes(image.filename)).map((image) => image.watermarkAccount));
const images = new Map();
try {
  for (const item of manifest.images.filter((image) => selectedAccounts.has(image.watermarkAccount))) {
    if (!/^IMG_\d{4}\.jpeg$/.test(item.filename) || images.has(item.filename)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !/^\d{8,12}$/.test(item.watermarkAccount)) {
      throw new Error(`Invalid image identity: ${item.filename}`);
    }
    if (item.identityConfirmation && (item.identityConfirmation !== 'user_confirmed_2026-09-22'
      || !['IMG_3024.jpeg','IMG_3025.jpeg','IMG_3026.jpeg'].includes(item.filename))) {
      throw new Error(`Invalid user-confirmed service identity: ${item.filename}`);
    }
    const filename = path.resolve(args.imagesRoot, item.filename);
    if (path.dirname(filename) !== path.resolve(args.imagesRoot)) throw new Error('Image path escapes root.');
    const bytes = fs.readFileSync(filename);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== item.sha256) throw new Error(`SHA-256 mismatch for ${item.filename}.`);
    const metadata = await sharp(bytes).metadata();
    const width = Number(metadata.width || 0), height = Number(metadata.height || 0);
    if (metadata.format !== 'jpeg' || !width || !height) throw new Error(`Invalid JPEG: ${item.filename}`);
    const audit = await auditSourcePhoto(filename, { assetKind: item.kind });
    if (item.useInArticle && item.kind === 'documentary_photo' && audit.status !== 'eligible') {
      throw new Error(`Selected photo failed local quality audit: ${item.filename}: ${audit.reasons.join(', ')}`);
    }
    images.set(item.filename, { ...item, bytes, width, height, audit });
  }
} finally {
  await closeLocalPhotoAudit();
}
if (!listed.length || new Set(listed).size !== listed.length
  || listed.some((filename) => !images.get(filename)?.useInArticle)) {
  throw new Error('Article/photo mapping must contain unique authorized photos.');
}
const db = new DatabaseSync(databasePath, { readOnly: args.mode === 'plan' });
db.exec('PRAGMA foreign_keys=ON');
db.exec('PRAGMA busy_timeout=5000');
if (args.mode === 'plan') db.exec('PRAGMA query_only=ON');
const repo = new Repository(db, { sourceUploadsDir: path.resolve(args.sourceRoot),
  generatedMediaDir: '/var/lib/solo-to-china/generated-media' });
try {
  const before = counts(db);
  const articlePlans = selectedArticles.map((article) => {
    const draft = db.prepare(`SELECT ad.id,ad.title,ad.revision,ad.status,ad.content_hash,ad.strategy_version,
      cb.strategy_version AS brief_strategy_version FROM article_drafts ad
      JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?`)
      .get(article.draftId);
    if (!draft || draft.revision !== article.expectedRevision) throw new Error(`Draft revision changed: ${article.draftId}`);
    if (draft.strategy_version !== draft.brief_strategy_version) {
      throw new Error(`Draft and canonical brief strategy differ: ${draft.id}`);
    }
    if (db.prepare('SELECT 1 FROM article_visuals WHERE draft_id=? LIMIT 1').get(draft.id)
      || db.prepare('SELECT 1 FROM required_media_manifests WHERE draft_id=? AND revision=?')
        .get(draft.id, draft.revision)) throw new Error(`Draft no longer has an empty media plan: ${draft.id}`);
    if (db.prepare("SELECT 1 FROM jobs WHERE entity_id=? AND status IN ('queued','running')")
      .get(draft.id)) throw new Error(`Draft has an active Job: ${draft.id}`);
    const owner = db.prepare('SELECT id FROM content_opportunities WHERE id=? AND approved_at IS NOT NULL')
      .get(article.opportunityId);
    if (!owner) throw new Error(`Approved owner missing: ${article.opportunityId}`);
    const pkg = repo.getDraftPackage(draft.id);
    const review = db.prepare(`SELECT * FROM quality_reviews WHERE draft_id=? AND draft_revision=?
      AND draft_content_hash=? AND passed=1 ORDER BY created_at DESC LIMIT 1`)
      .get(draft.id, draft.revision, draft.content_hash);
    if (!review) throw new Error(`Prior independent text QA missing: ${draft.id}`);
    return { ...article, draft, reviewId: review.id, evidenceHash: pkg.evidence_hash,
      reviewReusable: review.evidence_hash === pkg.evidence_hash };
  });
  const accounts = [...new Set([...images.values()].map((image) => image.watermarkAccount))].sort();
  for (const account of accounts) {
    if (db.prepare('SELECT 1 FROM sources WHERE source_identity=?').get(`editorial-media-20260922:${account}`)) {
      throw new Error(`Editorial source already imported for watermark account ${account}.`);
    }
  }
  const confirmation = crypto.createHash('sha256').update(JSON.stringify({
    manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    selectedArticleIds: selectedArticles.map((article) => article.draftId),
    articles: articlePlans.map(({ draft, evidenceHash }) => ({ id: draft.id, revision: draft.revision,
      contentHash: draft.content_hash, evidenceHash })),
  })).digest('hex');
  const plan = { mode: args.mode, productionDatabase: isLive, confirmation,
    articles: articlePlans.map(({ draft, images: selected, reviewReusable }) => ({ id: draft.id, title: draft.title,
      fromRevision: draft.revision, toRevision: draft.revision + 1, images: selected,
      reviewReusable, requiresIndependentReview: !reviewReusable })),
    sourcesToAdd: accounts.length, assetsToAdd: images.size, selectedVisuals: listed.length,
    excluded: [...images.values()].filter((image) => !image.useInArticle)
      .map(({ filename, reason }) => ({ filename, reason })),
    prior: before };
  if (args.mode === 'plan') {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }
  if (!args.confirmation || args.confirmation !== confirmation) throw new Error('Plan confirmation changed; re-plan first.');
  const assetIds = new Map();
  const queued = [];
  transaction(db, () => {
    console.error(`Import transaction started: ${accounts.length} sources, ${articlePlans.length} articles`);
    for (const account of accounts) {
      const accountImages = [...images.values()].filter((image) => image.watermarkAccount === account);
      const sourceKey = `editorial-media-20260922:${account}`;
      const capture = {
        adapter: 'manual', externalId: sourceKey, sourceIdentity: sourceKey,
        sourceVersionIdentity: crypto.createHash('sha256').update(accountImages.map((image) => image.sha256).join(':')).digest('hex'),
        canonicalUrl: `manual-source://editorial-media-20260922/${account}`,
        submittedUrl: '', originalUrl: '', finalUrl: '', sourceKind: 'images',
        title: `Operator-supplied Chongqing editorial media — Xiaohongshu account ${account}`,
        authorName: `Xiaohongshu account ${account} (visible watermark)`, authorUrl: '',
        sourcePublisher: 'Xiaohongshu account identified in supplied image watermark',
        submittedBy: 'administrator', publishedAt: null, capturedAt: now(), rawHtml: '',
        rawText: `User-supplied authorized editorial image originals. Visible watermark account: ${account}. `
          + accountImages.map((image) => `${image.filename}: ${image.subject}.`).join(' ')
          + ' Image captions describe visible scenes; Liangjiang Xiao Ferry identity was confirmed by the user, not inferred from pixels.',
        acquisitionOrigin: 'user_supplied_editorial_media',
        submissionMetadata: { editorialMediaOnly: true, manifest: 'editorial-media-20260922',
          terminalReason: 'image evidence supplied for existing approved articles; factual source extraction intentionally not requested' },
        completeness: { overall: 'complete' },
        rights: { authorizationStatus: 'owner_confirmed', commercialUseAllowed: true,
          editingAllowed: true, redistributionAllowed: true, publishable: true,
          authorizationOrigin: 'project_source_media_full_authorization', licenseScope: ['editorial', 'production'] },
        assets: accountImages.map((image, position) => ({ kind: 'image',
          url: `manual-asset://editorial-media-20260922/${account}/${image.filename}`,
          mediaIdentity: `sha256:${image.sha256}`, alt: image.subject, position,
          width: image.width, height: image.height, mimeType: 'image/jpeg',
          originalFilename: image.filename, originalSha256: image.sha256,
          originalDataUrl: `data:image/jpeg;base64,${image.bytes.toString('base64')}`,
          languageStatus: image.kind === 'photo_collage' ? 'mixed' : 'unknown',
          nearbyText: image.subject, captionText: image.caption,
          provenance: { originalFilename: image.filename, originalSha256: image.sha256,
            visibleWatermarkAccount: account, suppliedBy: 'user_attachment',
            editorialSubject: image.subject, useInArticle: image.useInArticle,
            identityConfirmation: image.identityConfirmation || null } })),
        files: [],
      };
      const saved = repo.saveCapture(capture);
      if (saved.duplicate || !saved.mediaDurabilityComplete) throw new Error(`Source capture incomplete for ${account}`);
      const canceled = db.prepare("DELETE FROM jobs WHERE entity_id=? AND type='extract_source' AND status='queued'")
        .run(saved.id).changes;
      if (canceled !== 1) throw new Error(`Unexpected media-only extraction queue state for ${account}`);
      db.prepare("UPDATE sources SET status='media_only' WHERE id=?").run(saved.id);
      for (const image of accountImages) {
        const asset = db.prepare('SELECT id,original_sha256,local_path FROM source_assets WHERE source_id=? AND remote_url=?')
          .get(saved.id, `manual-asset://editorial-media-20260922/${account}/${image.filename}`);
        if (!asset || asset.original_sha256 !== image.sha256 || !fs.existsSync(asset.local_path)) {
          throw new Error(`Stored original missing or changed: ${image.filename}`);
        }
        assetIds.set(image.filename, asset.id);
        repo.saveLocalPhotoAudit(asset.id, image.audit);
        if (!repo.saveSourceAssetAnalysis(asset.id, humanAnalysis(image),
          { provider: 'human_editorial', model: 'user-supplied-photo-review', withinTransaction: true })) {
          throw new Error(`Human image-level analysis not saved: ${image.filename}`);
        }
      }
      console.error(`Captured editorial source account ${account}`);
    }
    for (const article of articlePlans) {
      console.error(`Normalizing visuals for ${article.draft.id}`);
      const prior = db.prepare('SELECT * FROM quality_reviews WHERE id=?').get(article.reviewId);
      const timestamp = now(), refreshId = id('photo_refresh');
      if (article.reviewReusable) db.prepare(`INSERT INTO article_photo_refreshes(id,draft_id,from_revision,to_revision,
        previous_strategy_version,previous_visuals_json,reused_review_id,plan_hash,actor,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(refreshId, article.draft.id, article.draft.revision,
          article.draft.revision + 1, article.draft.strategy_version || '', '[]', prior.id,
          confirmation, 'operator_editorial_media_import', timestamp);
      db.prepare('UPDATE article_drafts SET revision=revision+1,updated_at=? WHERE id=? AND revision=?')
        .run(timestamp, article.draft.id, article.draft.revision);
      if (article.reviewReusable) db.prepare(`INSERT INTO quality_reviews(id,draft_id,passed,score,checks_json,issues_json,
        unsupported_claims_json,reviewer,strategy_version,created_at,draft_revision,draft_content_hash,evidence_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id('review'), article.draft.id, prior.passed, prior.score,
          prior.checks_json, prior.issues_json, prior.unsupported_claims_json,
          `reused_unchanged_text:${prior.id}`, prior.strategy_version, timestamp, article.draft.revision + 1,
          prior.draft_content_hash, prior.evidence_hash);
      repo.replaceDraftVisuals(article.draft.id, article.images.map((filename, index) => {
        const image = images.get(filename);
        return { placement: index === 0 ? 'after_intro' : 'mid_article',
          purpose: `Documentary view of ${image.subject}`,
          alt_text: image.subject, caption: image.caption, generation_prompt: '',
          aspect_ratio: '4:5', image_type: image.kind === 'photo_collage' ? 'infographic' : 'real_world_photo',
          image_role: index === 0 ? 'supporting' : 'inline', image_subject: image.subject,
          acquisition_strategy: 'analyze_source_image', factual_image_required: true,
          required_in_article: true, source_asset_id: assetIds.get(filename),
          source_remote_url: `manual-asset://editorial-media-20260922/${image.watermarkAccount}/${filename}`,
          status: 'planned', media_metadata: { editorial_source_filename: filename,
            visible_watermark_account: image.watermarkAccount,
            required_visual_obligation: { required: true,
              reason: 'operator_supplied_article_specific_editorial_media' } } };
      }), article.draft.strategy_version);
      repo.ensureAuthorizedSourceVisuals(article.draft.id, { strategyVersion: article.draft.strategy_version });
      const visuals = repo.listDraftVisuals(article.draft.id);
      const actualIds = new Set(visuals.map((visual) => visual.source_asset_id));
      if (visuals.length !== article.images.length
        || article.images.some((filename) => !actualIds.has(assetIds.get(filename)))) {
        const focus = db.prepare(`SELECT cb.topic,cb.destination_slug
          FROM article_drafts ad JOIN content_briefs cb ON cb.id=ad.brief_id WHERE ad.id=?`)
          .get(article.draft.id);
        throw new Error(`Media plan did not retain every selected image for ${article.draft.id}: ${JSON.stringify({
          focus,
          selected: article.images.map((filename) => ({ filename, assetId: assetIds.get(filename) })),
          actual: visuals.map((visual) => ({ slot: visual.slot, status: visual.status,
            sourceAssetId: visual.source_asset_id, strategy: visual.acquisition_strategy,
            gap: visual.media_metadata?.required_visual_gap || null })) })}`);
      }
      db.prepare("UPDATE frontend_page_compositions SET status='stale_contract',updated_at=? WHERE draft_id=?")
        .run(timestamp, article.draft.id);
      db.prepare("UPDATE frontend_publish_compositions SET status='stale_contract',updated_at=? WHERE draft_id=?")
        .run(timestamp, article.draft.id);
      const jobId = repo.enqueue('generate_visuals', article.draft.id, {
        dedupeKey: `operator-editorial-media:${article.draft.id}:r${article.draft.revision + 1}`,
        workloadClass: 'historical_recovery', recoveryRunId: refreshId,
        productionOwnerOpportunityId: article.opportunityId, pipelineVersion: 'article_bundle_v1' });
      if (!jobId) throw new Error(`Visual Job not queued for ${article.draft.id}`);
      queued.push({ draftId: article.draft.id, jobId, visuals: visuals.map((visual) => ({
        id: visual.id, status: visual.status, sourceAssetId: visual.source_asset_id,
        strategy: visual.acquisition_strategy, caption: visual.caption })) });
    }
  });
  const after = counts(db);
  console.log(JSON.stringify({ ...plan, mode: 'apply', queued, after,
    sourceDelta: after.sources - before.sources, assetDelta: after.source_assets - before.source_assets,
    visualDelta: after.article_visuals - before.article_visuals,
    modelCalls: after.model_call_metrics - before.model_call_metrics,
    wordpressRowsChanged: after.wordpress_publications !== before.wordpress_publications }, null, 2));
} finally {
  db.close();
}

function humanAnalysis(image) {
  const visibleSign = image.filename === 'IMG_3018.jpeg' ? '迎龙门'
    : image.filename === 'IMG_3019.jpeg' ? '磁器口' : '';
  const textRegions = image.kind === 'photo_collage'
    ? [{ region_id: 'editorial_title', role: 'author_overlay', language: 'zh', readable: true,
      preserve: false, text: '重庆 湖广会馆' }]
    : [{ region_id: 'visible_text', role: 'real_world_signage', language: 'zh',
      readable: Boolean(visibleSign), preserve: true, text: visibleSign }];
  textRegions.push({ region_id: 'attribution_watermark', role: 'ui_text', language: 'zh',
    readable: true, preserve: true, text: `小红书号：${image.watermarkAccount}` });
  return { source_sha256: image.sha256, analysis_status: 'ready', asset_kind: image.kind,
    text_regions: textRegions, photo_regions: [{ region_id: 'main_scene', subject: image.subject }],
    entities: [ { name: image.subject.includes('Ciqikou') ? 'Ciqikou Ancient Town'
      : image.subject.includes('Huguang') ? 'Huguang Guild Hall'
        : image.identityConfirmation ? 'Liangjiang Xiao Ferry' : 'Chongqing passenger ferry' } ],
    editor_ui_regions: [], primary_subjects: [image.subject],
    language_by_region: [{ region_id: 'attribution_watermark', language: 'zh' }],
    reader_text_present: true, confidence: image.kind === 'photo_collage' ? 0.85 : 0.9,
    analysis_version: 'media-analysis-2', prompt_version: 'human-editorial-review-20260922' };
}

function counts(db) {
  return Object.fromEntries(['sources', 'source_assets', 'article_drafts', 'article_visuals',
    'quality_reviews', 'jobs', 'model_call_metrics', 'wordpress_publications']
    .map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

function parseArgs(values) {
  const output = { mode: 'plan' };
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!['--database', '--images-root', '--source-root', '--manifest', '--mode',
      '--confirmation', '--production', '--article-ids'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    output[key.slice(2).replaceAll('-', '')] = values[++index] || '';
  }
  return { database: output.database, imagesRoot: output.imagesroot,
    sourceRoot: output.sourceroot, manifest: output.manifest, mode: output.mode,
    confirmation: output.confirmation, production: output.production,
    articleIds: output.articleids ? output.articleids.split(',').filter(Boolean) : [] };
}
