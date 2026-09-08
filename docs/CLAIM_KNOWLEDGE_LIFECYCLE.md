# Claim and Knowledge lifecycle

## Atomic extraction

Each Claim represents one proposition supported by the shortest useful exact source quote. Opening hours, transport, reservation requirements, route difficulty, photo opportunities, and recommendations are separate Claims even when the source presents them in one sentence.

Negation, quantities, exclusivity, uncertainty, time, audience, booking channel, and other material conditions belong in the predicate, value, qualifiers, or scope. They must not be discarded as writing style.

## Claim roles and Knowledge admission

Claims are durable evidence records. `claim_role` distinguishes facts, recommendations, personal experiences, promotional observations, and editorial metadata. `knowledge_eligible` controls only whether the active Claim participates in destination Knowledge.

- Facts and scoped recommendations are eligible by default.
- Personal experience and editorial metadata remain queryable evidence but are not destination Knowledge.
- Promotional observations are excluded unless extraction explicitly identifies a durable, independently useful place feature.

Exclusion from Knowledge never deletes the Claim, source quote, or captured Source.

## Administrator lifecycle controls

Source detail exposes reversible Claim exclusion and restoration. Excluded Claims remain in `claims` with an operator, reason, and timestamp, but do not participate in Entity resolution or Knowledge aggregation. The Knowledge tab exposes reversible hide/restore controls. Knowledge visibility decisions are stored by destination and normalized key, so they survive Knowledge rebuilds while underlying Claims and evidence remain unchanged.

These controls are deliberately not physical deletion. The administrator can remove an incorrect extraction from active research or hide an unsuitable aggregate conclusion without destroying provenance, extraction history, or the ability to audit and restore the decision.

## Typed facts

Stable fact identity does not depend on natural-language polarity placement. Reservation assertions use `reservation_required` with a boolean typed value. For example, `does not require = advance reservation` and `requires reservation = no reservation required` both normalize to `reservation_required=false`.

Advance days, channel, ticket type, date, and audience remain qualifiers or scope. Opposing booleans conflict only when their scopes are compatible.

## Extraction revisions

Every successful extraction creates an `extraction_runs` revision. The `claims` table is the active projection used by Entity resolution and Knowledge aggregation. Before a later extraction replaces that projection, every prior Claim is copied unchanged to `claim_history` and its extraction run becomes `superseded`.

Raw Sources and superseded Claim snapshots are never overwritten. Source detail responses expose both extraction runs and Claim history for audit.

## Review recalculation

Extraction review compares the source quote with the complete Claim semantics. Sibling Claims sharing the exact quote are evaluated together so a qualifier captured by one atomic Claim does not create duplicate warnings on another.

Contrastive wording and colloquial slogans are not logical negation. Missing logical negation or a material limiter remains reviewable. Migration 19 queues one Knowledge rebuild for each existing destination so historical pending cases are recalculated under these rules.

Procedural convenience wording such as “你只需要把衣服放进管家柜” does not assert that the named action is the only allowed option, so it is removed before material-limiter comparison. Semantic equivalents also count: contactless preserves “0 打扰 / 不打扰”. A genuine limit such as “only the east gate is open” remains reviewable when “only” is missing from the normalized Claim.

Positive descriptions under the same normalized feature key and compatible scope are enrichment rather than mutually exclusive single-value facts. This applies to view, scenery, appearance, lighting, vegetation, and amenity descriptions. Positive-versus-negative assertions and typed hard facts such as opening time, price, and reservation requirement retain strict conflict handling.

Visibility-from Claims are multi-value: a landmark may be visible from several viewpoints, so different positive is_visible_from values enrich the same fact. Semantic limiter coverage also recognizes a full-glass description with no walls or pillars as preserving “只有玻璃”; this exception is narrow and does not suppress unrelated missing “only” conditions.

The CMS review card explains in Chinese what source sentences were compared, why processing stopped, and the effect of each action. “可以同时成立” dismisses a false positive while retaining both Claims and their evidence. “确实矛盾” exposes final-value selection; choosing a value makes it the standard fact for later planning and writing without deleting either source.
