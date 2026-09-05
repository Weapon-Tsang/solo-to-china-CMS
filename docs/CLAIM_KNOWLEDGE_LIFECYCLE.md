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

## Typed facts

Stable fact identity does not depend on natural-language polarity placement. Reservation assertions use `reservation_required` with a boolean typed value. For example, `does not require = advance reservation` and `requires reservation = no reservation required` both normalize to `reservation_required=false`.

Advance days, channel, ticket type, date, and audience remain qualifiers or scope. Opposing booleans conflict only when their scopes are compatible.

## Extraction revisions

Every successful extraction creates an `extraction_runs` revision. The `claims` table is the active projection used by Entity resolution and Knowledge aggregation. Before a later extraction replaces that projection, every prior Claim is copied unchanged to `claim_history` and its extraction run becomes `superseded`.

Raw Sources and superseded Claim snapshots are never overwritten. Source detail responses expose both extraction runs and Claim history for audit.

## Review recalculation

Extraction review compares the source quote with the complete Claim semantics. Sibling Claims sharing the exact quote are evaluated together so a qualifier captured by one atomic Claim does not create duplicate warnings on another.

Contrastive wording and colloquial slogans are not logical negation. Missing logical negation or a material limiter remains reviewable. Migration 19 queues one Knowledge rebuild for each existing destination so historical pending cases are recalculated under these rules.
