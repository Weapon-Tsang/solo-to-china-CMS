# Frontend Capability Contract Integration

## 2.0.23 semantic presentation boundary

The CMS continues to emit semantic Page Payloads only. It does not copy or synthesize Frontend JSX/CSS. Reader-visible Markdown tables retained by historical Drafts are parsed into semantic table AST nodes and projected as readable Contract-native list items when the active Registry exposes no table renderer. Model output is instructed to use prose/lists, and final validation rejects leaked Markdown decorators or table syntax before WordPress delivery.

Authorized Source images are attached as media references with Source asset provenance, alt text and placement metadata. Selection is deterministic and relevance-scored; rendering, responsive styles and final visual treatment remain owned by the deployed WordPress theme and Frontend Contract.

## Ownership boundary

SoloToChina uses two repositories. The Frontend owns components, variants, schemas, Gutenberg serialization, presentation, and rendering. The CMS owns research, evidence, editorial composition, commercial selection, validation, and delivery.

The CMS never scans JSX/CSS or maintains a handwritten production component list. It may emit only components and variants published by the active Frontend Contract.

The CMS workbench's Page Composition Preview is a structural inspection of already persisted `frontend_page_plans.plan_json`, `frontend_page_compositions.payload_json`, or `frontend_publish_compositions.publish_package_json`. It may show block order, published component/variant identifiers, headings, content-node/evidence references, media, commercial markers, internal links, validation, schema/Contract versions and hashes. It never imports, duplicates, approximates or renders Frontend JSX/CSS and must state that WordPress theme visuals may differ. Only the Frontend/WordPress implementation can provide a final visual preview.

After a successful WordPress Draft acknowledgement, the CMS exposes the adapter's persisted `wordpress_publications.preview_url` as the final-page preview and `edit_url` as the editing entry. It does not synthesize either URL from a post ID.

The 2.0.13 production-state hotfix changes only CMS ownership/projection and responsive operator presentation. Mobile cards and the production-detail sheet consume the same persisted structural preview; they do not introduce a renderer, copied component implementation, invented variant, JSX or CSS from the Frontend repository.

The 2.0.14 operator UI correction is also CMS-only. It opens the card's secondary-action menu upward within the mobile card so the clipping boundary and following card cannot cover it, and it labels historical pipeline failures separately from the current recovery target. Neither change renders or copies Frontend components. Page Composition Preview and WordPress final preview continue to use only persisted Contract payloads and the adapter-provided `preview_url`/`edit_url`.

The 2.0.16 repair adds CMS-only production recovery state and operator controls for corrected destination scope, exact stage retry and targeted QA revision. It does not change the Frontend Contract, page payload Schema, component registry, public JSX or public CSS. The CMS still renders only its operator workbench; public page composition remains owned by the Frontend repository and persisted Contract artifacts.

The 2.0.17 Vertex repair changes only the CMS model transport and bounded Draft-revision input/output policy. It does not modify Frontend schemas, components, JSX, CSS, page payload ownership or WordPress rendering. Existing structural Page Composition previews and adapter-provided final preview/edit URLs retain the same contract boundary.

The 2.0.18 post-Draft join keeps the same boundary. A failed Frontend Page Payload remains an auditable parallel-branch result, but it cannot override a failing content-quality review or send recovery directly to the Commercial Layer. After targeted Draft repair, the CMS reuses the Contract schema to compose and validate a new payload; renderer JSX, CSS and final WordPress theme output remain Frontend-owned.

The 2.0.19 composition repair keeps Frontend Contract 1.4.0 unchanged. The CMS normalizes semantic article hierarchy, assigns evidence only to the atomic block that expresses it, and rebuilds Content AST/Page Payload/Publish Package from the current Draft. It validates mobile-readable heading order, answer-first content, SEO/GEO metadata, JSON-LD, media and link semantics, but visual typography, spacing, responsive CSS and renderer implementation remain owned by the Frontend/WordPress theme. Visual acceptance therefore uses the persisted `preview_url`; CMS structural preview is not presented as a screenshot of the final theme.

The 2.0.20 delivery adapter records an additional business invariant discovered by a real WordPress canary. Internal CMS taxonomy is deliberately richer than public renderer taxonomy, so `city_guide`, `first_time_guide`, `food_guide`, `neighborhood_guide`, `hotel_area_guide` and `shopping_guide` deliver as `city-guide`; `attraction_guide` as `attraction-guide`; `practical_guide`, `transport_guide` and `how_to` as `survival-kit`; and `itinerary`, `comparison` and `listicle` as `travel-guide`. This changes semantic delivery metadata only. It does not copy, emulate or modify Frontend JSX/CSS, and unknown values are blocked locally.

The 2.0.21 adapter also canonicalizes safe apostrophe entities to `&#039;`, the exact form preserved by the deployed WordPress sanitizer. This is transport normalization, not presentation logic: the rendered text is identical, no HTML capability is added, and all typography, spacing, responsive layout and components remain Frontend-owned.

Version 2.0.22 keeps CMS evidence provenance consistent with that delivery-only spelling. It remaps a block signature only after the complete stored provenance sequence exactly matches the original page; component selection, layout, JSX and CSS remain governed by the fixed Frontend Contract.

Three artifacts remain distinct:

- Research Draft (`body_markdown`): editorial, QA, evidence-review, and debug artifact.
- Frontend Page Payload (`frontend_page.payload`): ordered presentation composition.
- Publish Package: validated delivery artifact containing the final page, commercial overlay, SEO/GEO, media, and publication metadata.

## Audited Frontend implementation

The Frontend repository was audited at commit `ccfab41` (`feat(cms): deliver page payloads as WordPress drafts`). It publishes:

```text
contracts/component-registry.json
contracts/page-schema.json
contracts/cms-publish-package.schema.json
```

The corresponding read-only REST resources are:

```text
GET /wp-json/stc/v1/component-registry/generated
GET /wp-json/stc/v1/page-schema
GET /wp-json/stc/v1/cms-publish-package-schema
```

Draft delivery uses the Frontend-owned endpoint:

```text
POST /wp-json/stc/v1/cms-articles
PUT  /wp-json/stc/v1/cms-articles/{post_id}
```

The generated Registry uses `inputSchema`; the CMS consumes that field directly. Do not configure the Theme authoring source `content-contract/component-registry.v1.json`.

## Configuration and modes

Local integration may use paths to the three generated artifacts. Production should use the deployed website resources:

```dotenv
FRONTEND_CONTRACT_SOURCE_REPOSITORY=https://github.com/Weapon-Tsang/solo-to-china
FRONTEND_COMPONENT_REGISTRY_SOURCE=https://solotochina.com/wp-json/stc/v1/component-registry/generated
FRONTEND_PAGE_SCHEMA_SOURCE=https://solotochina.com/wp-json/stc/v1/page-schema
FRONTEND_PUBLISH_PACKAGE_SCHEMA_SOURCE=https://solotochina.com/wp-json/stc/v1/cms-publish-package-schema
FRONTEND_CONTRACT_COMMIT_SHA=<frontend-commit-sha>
WORDPRESS_CMS_ARTICLE_ENDPOINT=https://solotochina.com/wp-json/stc/v1/cms-articles
FRONTEND_CONTRACT_SYNC_HOURS=6
FRONTEND_CONTRACT_TIMEOUT_MS=15000
```

For HTTPS sources, the consumer appends the exact configured `FRONTEND_CONTRACT_COMMIT_SHA` as the `stc_frontend_commit` query parameter and requests revalidation. This makes each deployed frontend revision a distinct CDN cache key while preserving any existing source query parameters, so a release cannot silently synchronize the previous Contract from an edge cache.

Contract-aware publishing is enabled only when both Registry and Page Schema sources are configured. The Publish Package Schema source should also be configured for production. Leaving both core sources unset enables **Legacy publishing mode**:

```text
body_markdown / content_blocks
  -> CMS Markdown/Gutenberg renderer
  -> /wp-json/wp/v2/posts
```

Legacy renderer functions and direct `WORDPRESS_*_META_KEY` mappings exist only for this unconfigured fallback. Contract-aware delivery never calls them.

## Synchronization and compatibility

Synchronization runs at startup, on the maintenance interval, or manually:

```bash
npm run frontend-contract:sync
npm run frontend-contract:status
npm run frontend-contract:status -- --require-valid
```

Authenticated diagnostics are available at:

```text
GET  /api/frontend-contract
GET  /api/frontend-contract/capabilities?semantics=faq,warning
GET  /api/frontend-contract/compatibility
GET  /api/frontend-contract/capability-requests
POST /api/frontend-contract/sync
POST /api/frontend-contract/snapshots/:id/accept
```

Snapshots persist source locations, raw schemas, Contract versions, exact Registry-byte SHA-256 checksum, Frontend commit SHA, compatibility diff, and activation status. Fetch failure retains the Last Known Good Contract and reports `stale`. With no valid snapshot, composition and publishing stop with `NO_VALID_FRONTEND_CONTRACT`.

Patch and minor Contract revisions activate after validation. Major revisions remain blocked until explicitly accepted. Deprecated components remain readable for historical compatibility but are rejected for new composition.

## Contract-aware pipeline

```text
Research Sources
  -> Extraction
  -> Claims / Evidence / Knowledge
  -> Human recommendation approval
  -> plan_content
  -> compose_frontend_page_plan
  -> generate_draft
  -> compose_frontend_page
  -> review_draft
  -> compose_commercial
  -> compose_publish_page
  -> push_wordpress_draft
  -> WordPress STC CMS Article API
  -> Gutenberg Draft
```

Approval starts the production pipeline; it does not directly publish. Commercial selection occurs only after QA. The pre-QA Page Composer never receives offers or affiliate components.

`compose_publish_page` starts with the validated editorial Page Payload. `mergeCommercialOverlay()` deterministically inserts Registry-backed affiliate blocks only at approved contextual or end-resource slots. It does not call AI, rewrite editorial blocks, reorder them, or change their data. It then validates every component, the complete Page Schema, and the exact six-field Publish Package:

```text
contract
page
seo
schema_jsonld
media
publication
```

`page.metadata.presentation` is preserved as semantic data. The Frontend owns conversion to `_stc_*` post meta and Gutenberg. `push_wordpress_draft` consumes only the saved, validated Publish Package; it never reparses `body_markdown` in Contract-aware mode.

## Commercial capabilities

Registry `1.1.0` publishes `affiliate_booking_card`, `affiliate_search_card`, `affiliate_banner`, and `affiliate_promotion_card`. The merger maps stored commercial assets to their declared variants and data schemas and then revalidates the whole page.

If a selected commercial component is absent from the active Registry, the CMS saves a deduplicated `frontend_capability_request` and blocks Contract-aware delivery. It never invents component data, CSS, iframe HTML, or a Legacy substitute.

## Media and SEO/GEO

Generated and source-authorized images reuse `/wp-json/wp/v2/media`. Only successfully uploaded media IDs are offered to Page Composer. Placement is represented by Frontend `image` blocks; the final package also carries the referenced media manifest. Contract-aware publishing never invokes length-based `injectVisuals()` placement.

SEO title, description, search metadata, and `schema_jsonld` are sent as semantic Publish Package fields. The Frontend owns their WordPress meta implementation. Direct CMS meta-key mapping remains Legacy-only.

## Persistence and delivery safety

`frontend_page_plans` stores the Page Plan, `frontend_page_compositions` stores the editorial Page Payload, and `frontend_publish_compositions` stores the final package, Contract provenance, commercial strategy version, validation result, generation time, delivery status, and WordPress post ID. This preserves the audit relation:

```text
Editorial Page Payload + Commercial Overlay = Final Published Payload
```

The Frontend API uses stable `page.metadata.pageId` and `publication.cms_draft_id` for idempotent POST. Existing draft IDs use PUT. The Frontend rejects updates once a human has published the post.

Frontend validation errors are persisted with machine code and readable detail. `INVALID_PAGE_SCHEMA`, `UNKNOWN_COMPONENT`, `UNSUPPORTED_VARIANT`, `INVALID_COMPONENT_DATA`, `CONTRACT_VERSION_MISMATCH`, `INVALID_PRESENTATION`, `INVALID_COMMERCIAL_COMPONENT`, `UNSAFE_AFFILIATE_URL`, and `POST_NOT_DRAFT` do not automatically retry. Contract mismatch marks Page and Publish compositions stale and queues Contract synchronization. Network, rate-limit, and server failures retain bounded queue retries.

The WordPress dashboard view derives `Not ready`, `Ready to deliver`, `Queued`, `Delivered`, `Delivery failed`, and `WordPress Draft` from the persisted pipeline/publication state and exposes preview links and failure details when available.

## Verification

`npm test` covers the Contract Consumer, deterministic merger, pipeline, persistence, Legacy mode, and Contract-aware adapter. `npm run check` verifies builds and syntax. `npm run release:check` validates migrations and isolated server/API behavior.

The Frontend repository's WordPress Playground blueprint is the runtime E2E authority for the STC CMS Article endpoint. It verifies real Draft creation, exact Page Payload block order, Gutenberg serialization, presentation, SEO/JSON-LD, media, idempotent retry, structured validation errors, and published-post protection.
