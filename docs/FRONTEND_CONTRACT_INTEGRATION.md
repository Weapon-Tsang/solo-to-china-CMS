# Frontend Capability Contract Integration

## Purpose

SoloToChina uses two independent repositories. The Frontend owns presentation capability; this CMS owns editorial composition.

```text
Frontend: components, semantic variants, data schemas, visual design, renderer
CMS: research, evidence, component selection, variant selection, block order, page composition, validation, publishing
```

The CMS never scans React/JSX/CSS and never stores a hand-maintained production component list. A component may be used only after it appears in a synchronized, machine-readable Frontend Contract.

## Current source configuration

The Frontend repository was audited at commit `210d0fe` (`feat(contract): publish CMS capability schema`). It publishes the CMS-facing generated artifacts at:

```text
contracts/component-registry.json
contracts/page-schema.json
```

The generated Registry uses `inputSchema` for component data schemas; the CMS accepts that published field directly. Do not point the CMS at the Theme authoring source `content-contract/component-registry.v1.json`: its shape is intentionally different, and the current WordPress `/wp-json/stc/v1/component-registry` endpoint serves that authoring form rather than the generated CMS artifact. The Frontend also does not yet expose a public Page Schema REST endpoint.

For local integration, use filesystem paths to the two generated artifacts. For a controlled production rollout, use HTTPS artifacts from the reviewed Frontend repository or add Frontend endpoints that publish both generated files. Example repository URLs are:

```dotenv
FRONTEND_CONTRACT_SOURCE_REPOSITORY=https://github.com/Weapon-Tsang/solo-to-china
FRONTEND_COMPONENT_REGISTRY_SOURCE=https://raw.githubusercontent.com/Weapon-Tsang/solo-to-china/main/contracts/component-registry.json
FRONTEND_PAGE_SCHEMA_SOURCE=https://raw.githubusercontent.com/Weapon-Tsang/solo-to-china/main/contracts/page-schema.json
# optional provenance when the published JSON does not include it
FRONTEND_CONTRACT_COMMIT_SHA=<frontend-commit-sha>
FRONTEND_CONTRACT_SYNC_HOURS=6
FRONTEND_CONTRACT_TIMEOUT_MS=15000
```

Use HTTPS in production. Explicit filesystem paths are supported only for local development, controlled deployment artifacts, and tests. The CMS does not infer paths or create files in the Frontend repository.

Do not enable these variables in production until the reviewed Frontend commit is deployed and a manual sync succeeds. Keeping them unset retains the safe legacy WordPress path.

## What the CMS reads

The Component Registry must contain semantic `contractVersion`, `schemaVersion`, and `components[]`. Each component must provide an `id`, `category`, `purpose`, `status`, supported `variants`, and a JSON data schema. The Page Schema must carry the same `schemaVersion` and define the exact final page payload shape.

The CMS normalizes this into a queryable capability model:

```text
componentsById
componentsByCategory / semantic purpose match
stable components
deprecated components
variants and data schema per component
```

It provides only relevant candidates to the Composer based on editorial intent and evidence. Prompts receive candidates dynamically from the synchronized Contract; they do not contain a permanent component-name list.

## Synchronization and cache

Synchronization is queued at server startup and by the maintenance scheduler when both sources are configured. It can also be triggered manually:

```bash
npm run frontend-contract:sync
npm run frontend-contract:status
npm run frontend-contract:status -- --require-valid
```

HTTP diagnostics are available to authenticated dashboard users:

```text
GET  /api/frontend-contract
GET  /api/frontend-contract/capabilities?semantics=faq,warning
GET  /api/frontend-contract/compatibility
GET  /api/frontend-contract/capability-requests
POST /api/frontend-contract/sync
POST /api/frontend-contract/snapshots/:id/accept
```

Snapshots and state are stored in the CMS SQLite database in `frontend_contract_snapshots` and `frontend_contract_state`. They preserve the source repository/path, Contract and Schema versions, Frontend commit SHA when supplied, checksum, diff, timestamps, and activation status. This is a synchronized cache, not a second source of truth; no endpoint can add a component to it manually.

If fetching fails, the most recent active snapshot remains the **Last Known Good Contract** and status becomes `stale`. No successful snapshot means `NO_VALID_FRONTEND_CONTRACT`, and component-aware composition/publishing is blocked. The dashboard exposes this state under Settings.

## Version compatibility

Patch and minor Contract updates are activated after validation. The diff records added/removed components, variant changes, deprecations, component schema changes, and Page Schema changes.

A major `contractVersion` change is stored but not activated. State becomes `major_mismatch`; the last active Contract remains available for diagnosis but generation/publish composition is blocked. An administrator must review the snapshot and explicitly accept it through the API or internal tooling before it becomes active.

Deprecated components are excluded from new composition. Historical payloads validate with a warning so they can be migrated deliberately rather than rewritten automatically.

## Composition and generation flow

The legacy research model is unchanged. When a compatible Contract is active, the CMS adds two durable queue stages:

```text
Research Sources
  -> Extraction
  -> Claims / Evidence / Knowledge
  -> Human recommendation decision
  -> Editorial Planning
  -> Frontend Capability Resolution
  -> Page Composer plan (component, variant, final order)
  -> Structured content generation
  -> Frontend page payload composition
  -> Component validation + Page Schema validation
  -> Quality / SEO / GEO validation
  -> Commercial composition
  -> Publishing
  -> Frontend Renderer
```

`contentType` still controls research and editorial expectations, but it is not a hardcoded layout template. The Page Composer chooses only actual Registry components and declared variants. `blocks[]` order is persisted as the final intended render order.

The CMS stores page-plan provenance in `frontend_page_plans` and final page-payload provenance in `frontend_page_compositions`, including Contract version, Schema version, checksum, snapshot ID, model, validation result, and generated time. Internal provenance is never added to the public Frontend Page Schema.

If Contract sources are not configured, the existing Markdown/WordPress research workflow remains available for backwards compatibility. Once sources are configured, publishing requires a valid page payload generated from the active Contract as an additional release gate.

## Validation

The Contract Validator rejects:

- `UNKNOWN_COMPONENT`
- `UNSUPPORTED_VARIANT`
- `MISSING_REQUIRED_FIELD`
- undocumented data fields and other invalid component data
- use of a deprecated component in a new payload

The Page Schema Validator validates the complete payload after individual component validation. Both run before the component-aware publish path. A compatibility report revalidates existing saved page payloads against the currently active Contract without rewriting them.

## Missing capabilities

When no suitable stable capability exists for a real page-composition stage, the CMS creates a `frontend_capability_requests` record with the content use case, semantic need, affected brief/draft, and reason. It does not substitute an unknown component or simulate it with CSS.

The resolution path is:

```text
CMS records semantic gap
  -> Frontend designs and implements capability
  -> Frontend publishes Registry + Page Schema update
  -> CMS synchronizes
  -> Composer may use the new capability
```

## Affiliate component capabilities

Commercial composition uses the same consumer-only contract. The CMS may derive a semantic need for `affiliate_booking_card`, `affiliate_product_card`, `affiliate_search_card`, `affiliate_comparison_card`, `affiliate_banner`, `affiliate_promotion_card`, or `affiliate_disclosure`, but these names are requests—not a copied registry and not proof that the Frontend implements them.

After a QA-passed Research Draft produces block-level commercial intent, the Commercial Composer selects an existing Affiliate Asset and a semantic component. If the active Contract does not publish that component as non-deprecated, the CMS creates a `frontend_capability_request` containing the affected draft/brief and use case. It does not invent props, variants, CSS, or a replacement component. The independent WordPress adapter may still use its own server-validated Gutenberg fallback with safe data attributes, disclosure, allowlisted structured embeds, and sponsored link attributes.

Commercial data remains outside the Frontend page-planning and writing prompts. A Contract capability only controls whether the Frontend can safely render an already-selected Commercial Overlay; it never influences Research, Knowledge, topic choice, draft facts, QA conclusions, or the Evidence Ledger.

### Audited Frontend capability status

Registry `1.0.0` currently exposes one generic commercial capability, `affiliate_cta`. It safely renders an HTTPS link with disclosure and sponsored attributes, but its schema does not carry the Asset, slot, placement, destination/route/entity, or event-attribution fields required by the new Commercial Overlay. The CMS therefore does not silently reinterpret it as one of the richer components.

The Frontend component library should add, as real implemented and tested capabilities:

- `affiliate_booking_card` for high-intent Deep/Category Links;
- `affiliate_search_card` for allowlisted structured Search Box configuration;
- `affiliate_banner` for static and dynamic banners;
- `affiliate_promotion_card` for promotion assets;
- optional `affiliate_product_card`, `affiliate_comparison_card`, and `affiliate_disclosure` as product needs mature.

Their schemas should carry the CMS-selected `affiliate_asset_id`, provider, product category, slot key, placement, destination/route/entity scope, CTA/link or allowlisted embed configuration, disclosure, and strategy version. The Frontend—not the CMS—owns styling, responsive behavior, embed rendering, and impression/click dispatch. Public browser events need a same-origin WordPress relay or another explicitly secured ingestion design; the existing Engine event endpoint is protected as a dashboard API and must not expose an administrator credential to browser JavaScript.

Until those capabilities are published, the CMS records deduplicated `frontend_capability_request` entries and the WordPress adapter keeps its validated server-rendered fallback. Commercial components remain excluded from `resolveForArticle`, so the pre-QA Page Composer cannot select `affiliate_cta` or any future affiliate-prefixed capability.

## CI and test coverage

`npm test` runs Contract Consumer tests and end-to-end queue integration tests. Coverage includes valid blocks/order, unknown components/variants, required and undocumented fields, deprecation, minor and major update behavior, Last Known Good behavior, no-contract safe failure, API synchronization, and composition before the existing QA/WordPress stages.

`npm run check` performs syntax checks for the Contract Consumer and diagnostics scripts. The release check validates the Contract tables and API presence without requiring a remote Frontend Contract in an intentionally unconfigured environment.
