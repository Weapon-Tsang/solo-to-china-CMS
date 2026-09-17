# SoloToChina Content Production Strategy 3.6

Strategy 3.6 preserves the approved editorial scope, frozen Writing Packet, evidence and Claim history, stable page identity, draft-only WordPress boundary, finite retries, leases, image decisions and delivery reconciliation from Strategy 3.5. It adds evidence-complete failure diagnostics, resumable post-transform visual QA, isolated affiliate-asset revisions and article usage tracing. It does not authorize historical production repair or a second writing workflow.

## Repair evidence and execution contract

Deterministic page, contract and media gates preserve their original error list, JSON and schema paths, constraints, safe actual excerpts, stable slot/asset/component identity, input and candidate hashes, contract snapshot/checksum, Job attempt, recovery run and production owner. A deterministic gate has model execution `not_applicable`; absence of legacy telemetry is `unknown`, not invented proof that no call occurred.

Every external visual subcall records the actual provider, model, substage, visual/source identity, HTTP status when received, provider code/request ID when present, dispatch state and evidence basis. A local request gate is `not_attempted`; a transport break after dispatch is `unknown`; a response error remains a received response without asserting whether generation occurred. Missing tokens and cost remain unknown rather than zero.

After image transformation bytes pass basic decode, size and format checks, an immutable private candidate is persisted with source and transform hashes before independent QA. Transient QA failure keeps it `pending_qa`, and recovery repeats only QA. It is promoted to a public deliverable only after QA passes. Missing bytes, hash mismatch, changed inputs or stale ownership invalidate reuse.

Affiliate asset saves are revisioned and optimistic. Their content hash includes every selection/rendering field and the original valid URL bytes. A plain save computes the union of old consumers, old scope and new scope and marks matching commercial results stale, but does not silently queue model, image or WordPress work. Explicit application remains commercial-only and must preserve prose, evidence and media identities. Article usage distinguishes selected, legal page, publish package, WordPress receipt and DOM verification evidence, including unknown states and historical asset revisions.

## 不变的安全边界

事实保护、当前修订所有权、有限重试、幂等、明确的人类审批，以及仅写 WordPress 草稿的交付边界继续生效。媒体、版式和商业修复不得绕过这些约束，也不得把 DEVELOPMENT 验收解释为生产发布授权。

## Media decision contract

Every selected source image is decided from its persisted, capture-versioned `source_asset_analyses` record. An unknown image is analyzed before it can be treated as a photo. Region roles distinguish real-world signage from author overlays, so a photographed sign can be preserved without exempting an entire collage. The allowed paths are `PHOTO_RETAIN`, `PHOTO_OVERLAY_LOCALIZE`, `EDITORIAL_CARD_RECOMPOSE`, `COLLAGE_RECOMPOSE`, `MAP_OR_ROUTE`, and `ILLUSTRATION_GENERATE`.

Source transformations use the real source bytes and a fact manifest. Editorial cards are recomposed on a warm-white, light-blue system; documentary photos keep their natural appearance. Full binary decode, language, completeness, style, and semantic checks are separate states. A binary pass never implies the other checks passed. Final files use immutable byte-and-transform identities.

Media refresh is a delivery scope. It repairs only changed, failed, unqualified, or not-yet-analyzed slots, preserves qualified slots and body content, and retains the current CMS draft, Frontend page and WordPress post identities. A stale visual result cannot overwrite a newer fingerprint.

## Reading layout contract

Article pages use a compact, light text hero when no qualifying real image exists. On narrow screens, the table of contents is a native `details` disclosure containing a vertical list. Labels wrap in full at 320–430 CSS pixels and at enlarged text sizes; horizontal pills, ellipsis, hidden overflow and font shrinking are not acceptable substitutes.

## Commercial contract

The composer supports two independent levels: a strongly related contextual action beside its decision passage, and at most one optional destination-level planning resource after the article. Guide, itinerary, food, city and attraction articles may expose the latter without a booking keyword when a real scoped asset exists. The score of 70 controls creation of link-building work only; it never blocks insertion of an already configured eligible asset.

Empty outcomes are explicit: `asset_not_configured`, `eligibility_rejected`, `density_or_duplicate_suppressed`, or `intentional_noop`. Unknown traffic, booking value, or revenue is stored as unknown rather than invented. Every inserted slot must reconcile through composition, publish package, WordPress save and visible article DOM.

## Verification boundary

Development validation uses targeted tests first, then an additive schema replay, a disposable production-shaped database replay, browser checks on the real Parent/Child theme, a bounded real-model canary only when authorized inputs and provider credentials are present, and current seven-draft readback only when current production access is available. Historical snapshots cannot be reported as current inventory.
