# Frontend Capability Contract Integration

## Purpose

SoloToChina uses two independent repositories. The Frontend owns presentation capability; this CMS owns editorial composition.

```text
Frontend: components, semantic variants, data schemas, visual design, renderer
CMS: research, evidence, component selection, variant selection, block order, page composition, validation, publishing
```

The CMS never scans React/JSX/CSS and never stores a hand-maintained production component list. A component may be used only after it appears in a synchronized, machine-readable Frontend Contract.

## Current source configuration

The adjacent `solo-to-china` directory was empty when this integration was introduced, so this CMS intentionally has **no default Contract source**. That is safer than inventing a registry.

When the Frontend publishes its real artifacts, configure these server environment variables with the actual published file paths or HTTPS URLs:

```dotenv
FRONTEND_CONTRACT_SOURCE_REPOSITORY=https://github.com/<owner>/solo-to-china
FRONTEND_COMPONENT_REGISTRY_SOURCE=https://<published-host>/<actual-path>/component-registry.json
FRONTEND_PAGE_SCHEMA_SOURCE=https://<published-host>/<actual-path>/page-schema.json
# optional provenance when the published JSON does not include it
FRONTEND_CONTRACT_COMMIT_SHA=<frontend-commit-sha>
FRONTEND_CONTRACT_SYNC_HOURS=6
FRONTEND_CONTRACT_TIMEOUT_MS=15000
```

Use HTTPS in production. Explicit filesystem paths are supported only for local development, controlled deployment artifacts, and tests. The CMS does not infer paths or create files in the Frontend repository.

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

## CI and test coverage

`npm test` runs Contract Consumer tests and end-to-end queue integration tests. Coverage includes valid blocks/order, unknown components/variants, required and undocumented fields, deprecation, minor and major update behavior, Last Known Good behavior, no-contract safe failure, API synchronization, and composition before the existing QA/WordPress stages.

`npm run check` performs syntax checks for the Contract Consumer and diagnostics scripts. The release check validates the Contract tables and API presence without requiring a remote Frontend Contract in an intentionally unconfigured environment.
