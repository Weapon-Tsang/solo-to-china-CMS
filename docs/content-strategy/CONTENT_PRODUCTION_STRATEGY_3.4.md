# SoloToChina Content Production Strategy 3.4

Strategy 3.4 preserves the approved editorial scope, frozen Writing Packet, factual QA, revision ownership, finite retry policy, leases, `recovery_run_id`, and WordPress draft-only boundary from Strategy 3.3. It changes how the already-approved article is composed, illustrated, commercially overlaid, previewed, and verified. It does not authorize production writes or add a second writing workflow.

这些是不变的安全边界：任何呈现、媒体或商业层修复都不得绕过事实保护、当前修订所有权、有限重试、幂等和 draft-only 交付。

## Reading-task composition

The CMS owns content choice and block order. The active Frontend Registry remains the only component capability source, while the frontend owns rendering and styles. A frozen page plan must be consumed or produce an auditable substitution/omission. Component selection follows the local reader job, not a fixed content-type template:

- ordinary narrative remains a paragraph;
- a direct answer may become `quick_answer`;
- a compact factual set may become `quick_facts` or `key_takeaways`;
- a true comparison may become `comparison_table`;
- an ordered journey may become `route_timeline` or `steps`;
- a prerequisite, caveat, or hazard may become `tip` or `warning`.

The simplest component that fully preserves meaning wins. The page must not become a card collection, repeat the same answer in hero/summary/answer/takeaways, split a list or media group, or place a commercial action before the reader receives the relevant answer. Every enhanced choice keeps a private sidecar with its node/section source, reader job, placement reason, and any fallback reason.

## Visual delivery

All visual entry paths use one decision function. Stored source images retain provenance and must remain factually and destination relevant. Authentic photos and signage are not recolored to match a design system. Reader-facing Chinese or mixed text overlays, handwritten cards, and collages require a deliberate localization path; unclassified text-heavy assets do not pass as English/no-text photos. Low-resolution, unreadable, or editor-UI-dominated assets are rejected with a reason.

Localization preserves source geometry and does not force a planned aspect ratio. Generated or localized bytes must pass format, pixel-budget, and aspect checks before they are marked deliverable. Source SHA, capture version, crop, locale, transform/model configuration, style version, QA version, and final derivative identity participate in reuse. One successful image is never regenerated merely because another slot fails.

Food guides may use five to eight useful, non-duplicative source photos when the evidence and retained assets support them. This is a soft selection target, never a quota that permits unrelated filler or fabricated documentary images. Media follows a stable semantic node where possible and carries an accurate subject-specific caption.

## Commercial overlay

Commercial content remains a separate overlay over a QA-passed editorial page. Intent detection reads only declared visible component fields, including Contract `list.data.items`; URLs, identifiers, strategy metadata, and hidden configuration never create intent. Negative statements such as free/no-booking and metro-station mentions must not create the opposite booking action.

Assets are matched through normalized ENTITY, ROUTE, AREA, DESTINATION, COUNTRY, CATEGORY, and GLOBAL scopes, including active mappings. Provider status, lifecycle, active flag, date window, language, URL, renderer capability, and scope are explicit eligibility gates. COUNTRY uses a normalized country code and never compares a country to a city key.

Results are distinct:

- `inserted`: at least one selected slot survives composition;
- `intentional_noop`: the article has no relevant commercial need;
- `asset_gap`: a relevant need exists but no eligible asset can satisfy it;
- `stale`, `blocked`, or `delivery_mismatch`: an existing/selected overlay cannot safely reach the next boundary.

Slot identity follows a stable editorial anchor, action scope, asset, component, and placement. Different entities of one product category may compete within the density budget; the same action/asset cannot repeat. Banner-like units remain end resources. The overlay version covers the draft revision/content hash, editorial page and anchors, normalized intents, candidate inventory/mappings, selected asset fields and validity, commercial/reading-layout versions, and Contract checksum.

Every selected slot must reconcile through merged page, Publish Package, WordPress storage receipt, and visible DOM. A zero-plan/zero-output page is valid. A selected slot missing downstream is an exact delivery failure, never a successful `no_offers` result.

## Incremental repair and preview

Asset or mapping changes mark only affected commercial compositions refreshable. Explicit repair reuses current QA prose and media, recalculates only commercial/publish/delivery stages, targets the existing WordPress draft, and stops on a published or externally modified post. Overlay history supports article-scoped rollback; it does not roll back the database or delete shared assets.

Final preview is click-time and identity-bound. When the frontend supports it, an authenticated editor mints a short-lived opaque capability bound to one WordPress draft and delivered page hash. The response is private/no-store/noindex, strips referrer leakage, and does not emit commercial analytics. Without that capability, the UI explicitly asks the editor to log into WordPress and returns to the same draft; it never falls back to the home page.

## Acceptance boundary

Fixtures prove deterministic contracts but do not prove current production assets, a real model output, an active Parent/Child theme, mobile devices, or WordPress visible DOM. Those layers must be reported independently. DEVELOPMENT work never implies commit, push, deployment, production migration, production database mutation, or WordPress write.
