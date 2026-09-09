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
    url: "https://solotochina.com/draft-preview/", httpStatus: 200, sitemapXml: `${sitemap}<loc>https://solotochina.com/draft-preview/</loc>` });
  assert.ok(leaked.errors.some((item) => item.code === "DRAFT_PAGE_INDEXABLE"));
  assert.ok(leaked.errors.some((item) => item.code === "DRAFT_PAGE_IN_SITEMAP"));
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
