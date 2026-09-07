# Frontend Capability Contract Integration

## Ownership boundary

SoloToChina uses two repositories. The Frontend owns components, variants, schemas, Gutenberg serialization, presentation, and rendering. The CMS owns research, evidence, editorial composition, commercial selection, validation, and delivery.

The CMS never scans JSX/CSS or maintains a handwritten production component list. It may emit only components and variants published by the active Frontend Contract.

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
