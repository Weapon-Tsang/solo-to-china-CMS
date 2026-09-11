# SEO/GEO Frontend dependencies

This matrix keeps CMS-owned evidence and delivery checks separate from Frontend,
WordPress, network and search-engine outcomes. Passing an offline fixture is never
reported as ranking, indexing, traffic, Core Web Vitals or AI-citation evidence.

| Responsibility | Owner | Versioned fixture / source | Verification command | Current status |
| --- | --- | --- | --- | --- |
| Evidence-bounded title, description, canonical decision and metadata hash | CMS | schema 52; `test/seo-geo.test.mjs` | `node --test test/seo-geo.test.mjs` | Verified offline |
| Article/WebPage/Breadcrumb and optional visible FAQ consistency | CMS | final Page + Draft hash | `node --test test/seo-geo.test.mjs` | Verified offline |
| Media evidence role, public URL, dimensions, MIME, bytes, hash and reusable derivatives | CMS/WordPress API | `test/media-delivery.test.mjs` | `node --test test/media-delivery.test.mjs` | Verified with deterministic WordPress response fixture |
| Responsive `<img>`, intrinsic dimensions, LCP priority and later lazy loading | Frontend/WordPress | Contract 1.3.0 at `f44ce1092ced93dfb47d9b3eae83d0d5e4b97086`; fixed HTML fixture | `npm run test:cross-repo`; `node --test test/final-html-validator.test.mjs` | Contract + offline HTML verified; production unverified |
| Published status, visible initial body, one H1, canonical, links, media and JSON-LD | Frontend/WordPress | `test/fixtures/published-article.html` | `node --test test/final-html-validator.test.mjs` | Fixed fixture verified; real published page unverified |
| Draft/preview noindex and public sitemap exclusion | Frontend/WordPress | `test/fixtures/draft-preview.html` | `node --test test/final-html-validator.test.mjs` | Fixed fixture verified; production configuration unverified |
| `X-Robots-Tag`, `robots.txt`, sitemap, authentication, CDN/WAF and WordPress site visibility | WordPress/hosting | Real response headers and public endpoints | Deployment smoke checklist | Unverified until a deployed environment is supplied |
| Mobile/desktop factual equivalence and no crawler-specific body | Frontend | fixed HTML variants | `node --test test/final-html-validator.test.mjs` | Deterministic equality verified; real device render unverified |
| Google URL Inspection / live test | Site operator | Real Search Console property and published URL | Manual Google Search Console live test | Not configured / not tested; no GSC topic discovery added |
| AI crawler behavior or citations | External systems | None | None | Not claimed; no fabricated user agents or `llms.txt` promise |
| Rankings, CTR, traffic and real-user CWV | Search engines / field data | None in CMS | Production analytics only | Not tested and never inferred from metadata/schema |

## Fixed-SHA WordPress Playground observation (2026-09-10)

An isolated detached worktree at Frontend commit
`f44ce1092ced93dfb47d9b3eae83d0d5e4b97086` ran WordPress Playground CLI
3.1.52 with PHP 8.3 and WordPress 7.0.4. The separate published fixture URL
`/china-mobile-payment-setup/` returned HTTP 200 with 43,473 HTML bytes. It
passed initial visible body, single H1, canonical, robots.txt, WordPress sitemap
membership and mobile/desktop article-text equality. It failed three real-theme
checks: no meta description, no Article JSON-LD, and the first image retained
`loading="lazy"`. The fixed Frontend repository's own full Blueprint also stopped
at its CMS draft step because `contract.contractChecksum` returned
`CONTRACT_VERSION_MISMATCH`. These are Frontend/WordPress handoff items, not CMS
fixture passes; no adjacent Frontend files were changed. The temporary worktree
and Playground runtime were removed after the observation.

## C04 performance boundary

Before C04, the legacy renderer emitted image URLs and alt text but no intrinsic
dimensions, responsive candidates or explicit loading priority. After C04, the
deterministic fixture verifies width/height, `srcset`/`sizes`, one high-priority
first image and lazy loading for later images. This is a structural before/after
record, not an invented millisecond or Core Web Vitals percentage. A real CWV
baseline and after-measurement require the same published URL, fixed Frontend SHA,
device profile and network profile in an actual WordPress environment.

## Deployment acceptance

For a real release, record the exact Frontend commit, WordPress/theme/plugin
versions, published fixture URL, HTTP status, response headers, rendered HTML,
robots.txt and sitemap responses. Run the CMS validator against those artifacts,
then run Google's live URL test separately. Draft/admin protection, `noindex`,
robots disallow and authentication are independent controls and must be reported
independently.
