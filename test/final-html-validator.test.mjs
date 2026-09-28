import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compareRenderedVariants, validateRenderedHtmlArtifact } from "../src/final-html-validator.mjs";

const fixtures = path.resolve("test/fixtures");
const publishedHtml = fs.readFileSync(path.join(fixtures, "published-article.html"), "utf8");
const sitemap = "<urlset><url><loc>https://solotochina.com/chongqing-night-transport/</loc></url></urlset>";
const base = { html: publishedHtml, status: "publish", url: "https://solotochina.com/chongqing-night-transport/", httpStatus: 200,
  headers: { "content-type": "text/html" }, robotsTxt: "User-agent: *\nDisallow: /wp-admin/", sitemapXml: sitemap,
  expectedTitle: "Chongqing Night Transport Guide",
  expectedDescription: "An evidence-bounded guide to one Chongqing evening transport route.", authenticated: false,
  fixture: { type: "fixed_published_html", frontendCommitSha: "f44ce1092ced93dfb47d9b3eae83d0d5e4b97086", viewport: "mobile_and_desktop" } };

test("fixed published HTML passes visible body, SEO, schema, media and crawler checks without outcome claims", () => {
  const result = validateRenderedHtmlArtifact(base);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.dimensions.production_cost.status, "not_tested");
  assert.deepEqual(result.conclusions, { ranking: "not_tested", indexing: "not_tested", aiCitation: "not_tested" });
});

test("draft preview requires noindex and exclusion from the public sitemap", () => {
  const html = fs.readFileSync(path.join(fixtures, "draft-preview.html"), "utf8");
  assert.equal(validateRenderedHtmlArtifact({ html, status: "draft", url: "https://solotochina.com/?p=71&preview=true",
    httpStatus: 200, authenticated: true, robotsTxt: "User-agent: *\nDisallow: /wp-admin/", sitemapXml: sitemap }).valid, true);
  const leaked = validateRenderedHtmlArtifact({ html: html.replace("noindex,nofollow", "index,follow"), status: "draft",
    url: "https://solotochina.com/draft-preview/", httpStatus: 200, sitemapXml: sitemap.replace('</urlset>', '<url><loc>https://solotochina.com/draft-preview/</loc></url></urlset>') });
  assert.ok(leaked.errors.some((item) => item.code === "DRAFT_PAGE_INDEXABLE"));
  assert.ok(leaked.errors.some((item) => item.code === "DRAFT_PAGE_IN_SITEMAP"));
});

test("draft preview validates article identity, body, media and commercial slots instead of accepting any HTTP 200", () => {
  const html = `<!doctype html><html><head><title>Exact draft</title><meta name="robots" content="noindex"></head><body><main><article>
    <h1>Exact draft</h1><p>${"Reader-visible draft content. ".repeat(8)}</p>
    <img class="wp-image-91" src="https://solotochina.com/media/91.webp" width="1200" height="800" alt="Route" fetchpriority="high">
    <aside data-stc-slot-key="contextual:hotel:one" data-affiliate-asset="asset-hotel">Hotel option</aside>
  </article></main></body></html>`;
  const result=validateRenderedHtmlArtifact({ html,status:"preview",url:"https://solotochina.com/?p=71&preview=true",httpStatus:200,
    expectedTitle:"Exact draft",expectedMediaIds:[91],expectedCommercialSlots:[{slot_key:"contextual:hotel:one",affiliate_asset_id:"asset-hotel"}] });
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  const wrong=validateRenderedHtmlArtifact({ html:html.replaceAll("Exact draft","Home").replace("data-stc-slot-key","data-missing-slot"),
    status:"preview",url:"https://solotochina.com/?p=71&preview=true",httpStatus:200,expectedTitle:"Exact draft",
    expectedMediaIds:[91,92],expectedCommercialSlots:[{slot_key:"contextual:hotel:one",affiliate_asset_id:"asset-hotel"}] });
  assert.ok(wrong.errors.some((item)=>item.code==="HTML_TITLE_MISMATCH"));
  assert.ok(wrong.errors.some((item)=>item.code==="EXPECTED_MEDIA_MISSING"));
  assert.ok(wrong.errors.some((item)=>item.code==="COMMERCIAL_SLOT_VISIBLE_COUNT_MISMATCH"));
});

test('T03-08 preview schema uses the explicit public canonical, preserving meaningful query and slash identity', () => {
  const canonical='https://solotochina.com/guide/?lang=en';
  const html=`<html><head><title>Guide</title><meta name="robots" content="noindex"><link rel="canonical" href="${canonical}">
    <script type="application/ld+json">{"@type":"Article","headline":"Guide","url":"${canonical}"}</script></head>
    <body><article><h1>Guide</h1><p>Use the supported entrance.</p></article></body></html>`;
  const input={html,status:'preview',url:'https://solotochina.com/?p=71&preview=true',httpStatus:200,expectedTitle:'Guide',expectedCanonicalUrl:canonical};
  assert.equal(validateRenderedHtmlArtifact(input).valid,true);
  for(const expectedCanonicalUrl of ['https://solotochina.com/guide?lang=en','https://solotochina.com/guide/?lang=fr'])
    assert.ok(validateRenderedHtmlArtifact({...input,expectedCanonicalUrl}).errors.some(e=>e.code==='HTML_SCHEMA_URL_MISMATCH'));
  assert.ok(validateRenderedHtmlArtifact({...input,expectedCanonicalUrl:'http://localhost/guide'}).errors.some(e=>e.code==='HTML_CANONICAL_EXPECTATION_INVALID'));
  assert.ok(validateRenderedHtmlArtifact({...input,html:html.replace('noindex','index')}).errors.some(e=>e.code==='DRAFT_PAGE_INDEXABLE'));
});

test("published HTML fails for inherited noindex, hidden body, broken headings, media or schema", () => {
  const broken = publishedHtml
    .replace("<title>", '<meta name="robots" content="noindex"><title>')
    .replace("<h1>Chongqing Night Transport Guide</h1>", "<h1>One</h1><h1>Two</h1>")
    .replace('width="1200" height="800"', "")
    .replace('"headline":"Chongqing Night Transport Guide"', '"headline":"Invented title"')
    .replace("<article>", '<article data-lazy-content="true">');
  const result = validateRenderedHtmlArtifact({ ...base, html: broken });
  const codes = result.errors.map((item) => item.code);
  for (const code of ["PUBLISHED_PAGE_NOINDEX", "H1_COUNT_INVALID", "CRITICAL_BODY_DEFERRED", "HTML_IMAGE_DIMENSIONS_MISSING", "HTML_SCHEMA_HEADLINE_MISMATCH"]) assert.ok(codes.includes(code), code);
});

test("mobile, desktop and ordinary user-agent variants must expose the same article facts", () => {
  assert.equal(compareRenderedVariants({ mobile: publishedHtml, desktop: publishedHtml, browser: publishedHtml }).valid, true);
  const changed = publishedHtml.replace("confirmed station exit", "unconfirmed station exit");
  assert.equal(compareRenderedVariants({ mobile: publishedHtml, desktop: changed }).valid, false);
});

test('T03-03 document title, H1 and card title are independent', () => {
  const html = publishedHtml.replace('<title>Chongqing Night Transport Guide</title>', '<title>Chongqing Night Transport Guide | SoloToChina</title>');
  assert.equal(validateRenderedHtmlArtifact({ ...base, html, expectedDocumentTitle: 'Chongqing Night Transport Guide | SoloToChina', expectedH1: base.expectedTitle }).valid, true);
  assert.ok(validateRenderedHtmlArtifact({ ...base, html, expectedH1: 'Card title' }).errors.some(item => item.code === 'HTML_H1_MISMATCH'));
});

test('T03-04/05 rendered HTML uses all robots tags and the selected crawler group', () => {
  const robotsTxt = 'User-agent: Googlebot\nAllow: /\nUser-agent: GPTBot\nDisallow: /';
  assert.equal(validateRenderedHtmlArtifact({ ...base, robotsTxt }).valid, true);
  const html = publishedHtml.replace('<head>', '<head><meta name="robots" content="index"><meta name="robots" content="noindex">');
  const codes = validateRenderedHtmlArtifact({ ...base, html, robotsTxt }).errors.map(item => item.code);
  assert.ok(codes.includes('PUBLISHED_PAGE_NOINDEX'));
  assert.ok(codes.includes('ROBOTS_DIRECTIVE_CONFLICT'));
  assert.equal(validateRenderedHtmlArtifact({ ...base, headers: { 'X-Robots-Tag': 'otherbot: noindex' } }).valid, true);
});

test('T03-06 logo first and multiple eager images do not pretend to identify measured LCP', () => {
  const html = publishedHtml.replace('<body>', '<body><img src="https://solotochina.com/logo.png" width="60" height="60" loading="lazy">').replace('loading="lazy">\n</article>', 'loading="eager">\n</article>');
  const result = validateRenderedHtmlArtifact({ ...base, html });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.dimensions.lcp.status, 'not_measured');
  assert.ok(validateRenderedHtmlArtifact({ ...base, html, lcpObservation: { index: 0, source: 'browser-performance' } }).errors.some(item => item.code === 'LCP_IMAGE_LAZY'));
});

test('T03-10 a later conflicting Article in an array cannot hide behind the first valid script', () => {
  const html = publishedHtml.replace('</head>', '<script type="application/ld+json">[{"@type":"Article","headline":"Invented","url":"https://solotochina.com/?p=22"}]</script></head>');
  const codes = validateRenderedHtmlArtifact({ ...base, html }).errors.map(item => item.code);
  assert.ok(codes.includes('HTML_SCHEMA_HEADLINE_MISMATCH'));
  assert.ok(codes.includes('HTML_SCHEMA_URL_MISMATCH'));
});

test('T03-01/02/07 unobserved external checks remain pending while missing content fails independently', () => {
  const pending = validateRenderedHtmlArtifact({ ...base, robotsTxt: null, sitemapXml: '', pageRevision: 3, evidenceSource: 'fixture' });
  assert.equal(pending.valid, null);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.health.sitemap.status, 'unknown');
  assert.equal(pending.health.crawler.status, 'unknown');
  assert.equal(pending.health.content.status, 'passed');
  assert.equal(pending.health.content.pageRevision, 3);
  const absent = validateRenderedHtmlArtifact({ ...base, html: publishedHtml.replace(/<main>[\s\S]*<\/main>/, '<main/>') });
  assert.equal(absent.health.content.status, 'failed');
  assert.equal(absent.valid, false);
});

test('T03-09 all head outputs are compared; plugin identity is not inferred', () => {
  const html = publishedHtml.replace('</head>', '<link rel="canonical" href="https://solotochina.com/?p=999"><meta name="description" content="Conflicting output"></head>');
  const result = validateRenderedHtmlArtifact({ ...base, html });
  assert.equal(result.errors.filter(item => item.code === 'HTML_HEAD_OUTPUT_CONFLICT').length, 2);
});

test('T03-09 Rank Math enabled, disabled and unknown-plugin response fixtures are checked by actual output',()=>{
  const enabled=publishedHtml.replace('</head>','<!-- Rank Math SEO plugin fixture --></head>');
  assert.equal(validateRenderedHtmlArtifact({...base,html:enabled}).valid,true);
  const disabled=publishedHtml.replace(/<meta name="description"[^>]*>/i,'');
  assert.ok(validateRenderedHtmlArtifact({...base,html:disabled}).errors.some(e=>e.code==='HTML_DESCRIPTION_MISMATCH'));
  const unknown=publishedHtml.replace('</head>','<!-- unknown plugin --><link rel="canonical" href="https://solotochina.com/wrong/"></head>');
  assert.ok(validateRenderedHtmlArtifact({...base,html:unknown}).errors.some(e=>e.code==='HTML_HEAD_OUTPUT_CONFLICT'));
});

test('T03-17 unavailable anonymous HTML cannot be scored as missing article content', () => {
  const result = validateRenderedHtmlArtifact({ ...base, html: '<h1>Forbidden</h1>', httpStatus: 403 });
  assert.equal(result.valid, null);
  assert.equal(result.health.content.status, 'unknown');
  assert.deepEqual(result.errors, []);
});

test('T03-01/20 hidden and template text cannot satisfy initial content or important facts', () => {
  for (const attribute of ['hidden', 'style="display:none"', 'aria-hidden="true"', 'style="visibility: hidden !important"']) {
    const html = publishedHtml.replace('<article>', `<article ${attribute}>`);
    const result = validateRenderedHtmlArtifact({ ...base, html, expectedFacts: ['confirmed station exit'] });
    assert.ok(result.errors.some(item => item.code === 'INITIAL_HTML_BODY_MISSING'), attribute);
    assert.ok(result.errors.some(item => item.code === 'IMPORTANT_FACT_NOT_VISIBLE'), attribute);
  }
  const hidden = publishedHtml.replace('</article>', '<template>secret fact</template><!-- secret fact --></article>');
  assert.ok(validateRenderedHtmlArtifact({ ...base, html: hidden, expectedFacts: ['secret fact'] }).errors.some(item => item.code === 'IMPORTANT_FACT_NOT_VISIBLE'));
});

test('T03-03/05 HTML entities and unquoted attributes use HTML parsing semantics', () => {
  const html = publishedHtml.replace('<head>', '<head><meta name=robots content=noindex>');
  assert.ok(validateRenderedHtmlArtifact({ ...base, html }).errors.some(item => item.code === 'PUBLISHED_PAGE_NOINDEX'));
  const title = publishedHtml.replaceAll('Chongqing Night Transport Guide', 'Chongqing &#38; Transport Guide');
  // JSON-LD is raw JSON: entity references are not HTML-decoded in script data.
  const corrected = title.replace('"headline":"Chongqing &#38; Transport Guide"', '"headline":"Chongqing & Transport Guide"');
  assert.equal(validateRenderedHtmlArtifact({ ...base, html: corrected, expectedTitle: 'Chongqing & Transport Guide' }).valid, true);
});

test('T03-12 FAQ markup requires visible matching questions and answers, markup itself is optional', () => {
  const faq = { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Which exit?', acceptedAnswer: { '@type': 'Answer', text: 'Use the confirmed station exit.' } }] };
  const schema = `<script type=application/ld+json>${JSON.stringify(faq)}</script>`;
  const content = '<section><h2>Which exit?</h2><p>Use the confirmed station exit.</p></section>';
  assert.equal(validateRenderedHtmlArtifact({ ...base, html: publishedHtml.replace('</article>', content + '</article>') }).valid, true);
  for (const hidden of ['', ' hidden']) {
    const html = publishedHtml.replace('</head>', schema + '</head>').replace('</article>', content.replace('<section>', `<section${hidden}>`) + '</article>');
    assert.equal(validateRenderedHtmlArtifact({ ...base, html }).errors.some(item => item.code === 'HTML_FAQ_NOT_VISIBLE'), Boolean(hidden));
  }
});

test('T03-10/11 same identity conflicts and explicit author/date evidence are checked across scripts', () => {
  const nodes = [{ '@type': 'Person', '@id': '#editor', name: 'Real editor' },
    { '@type': 'Person', '@id': '#editor', name: 'Invented editor' }];
  const html = publishedHtml.replace('</head>', `<script type=application/ld+json>${JSON.stringify(nodes)}</script></head>`);
  assert.ok(validateRenderedHtmlArtifact({ ...base, html }).errors.some(item => item.code === 'HTML_SCHEMA_ID_CONFLICT'));
  const invented = publishedHtml.replace('"@type":"Article"', '"@type":"Article","author":{"name":"Invented editor"},"datePublished":"2026-09-28"');
  const result = validateRenderedHtmlArtifact({ ...base, html: invented, expectedSchemaEvidence: { authorNames: [], datePublished: null } });
  assert.ok(result.errors.some(item => item.code === 'HTML_SCHEMA_AUTHOR_UNSUPPORTED'));
  assert.ok(result.errors.some(item => item.code === 'HTML_SCHEMA_DATE_UNSUPPORTED'));
  const draft = validateRenderedHtmlArtifact({ ...base, status: 'draft', html: invented });
  assert.ok(draft.errors.some(item => item.code === 'DRAFT_SCHEMA_PUBLICATION_DATE'));
});

test('T03-01 concise useful content has no arbitrary minimum character gate', () => {
  const html = '<html><head><title>Exit</title><meta name=robots content=noindex></head><body><main><h1>Exit</h1><p>Use exit 2.</p></main></body></html>';
  assert.equal(validateRenderedHtmlArtifact({ html, status: 'draft', url: base.url, httpStatus: 200, expectedH1: 'Exit', expectedFacts: ['Use exit 2.'] }).valid, true);
});

test('T03-15 hidden images and fake class references do not satisfy required media', () => {
  for (const replacement of ['<div class="wp-image-987">Not an image</div>', '<img hidden class=wp-image-987 src="https://solotochina.com/a.webp" width=900 height=600>']) {
    const result = validateRenderedHtmlArtifact({ ...base, html: publishedHtml.replace('</article>', replacement + '</article>'), expectedMediaIds: [987] });
    assert.ok(result.errors.some(item => item.code === 'EXPECTED_MEDIA_MISSING'));
  }
});

test('T03-06/15 responsive candidate omissions and fake WebP bytes are diagnosed', () => {
  const html = publishedHtml.replace('<img ', '<img srcset="https://solotochina.com/large.webp 1200w" ');
  const result = validateRenderedHtmlArtifact({ ...base, html, imageObservations: [{ index: 0, bytes: Buffer.from('not webp'), contentType: 'image/webp' }] });
  assert.ok(result.warnings.some(item => item.code === 'HTML_IMAGE_SIZES_MISSING'));
  assert.ok(result.errors.some(item => item.code === 'HTML_IMAGE_FORMAT_MISMATCH'));
});

test('T03-15/17 inaccessible image is unknown rather than a media pass or fabricated absence', () => {
  const result = validateRenderedHtmlArtifact({ ...base, imageObservations: [{ index: 0, httpStatus: 403 }] });
  assert.equal(result.health.media.status, 'unknown');
  assert.equal(result.valid, null);
  assert.equal(result.warnings.find(item => item.code === 'HTML_IMAGE_ACCESS_UNKNOWN').severity, 'unknown');
});
