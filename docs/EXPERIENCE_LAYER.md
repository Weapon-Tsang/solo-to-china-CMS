# Experience semantic layer

Experience is the structured travel-logic layer between Claims and editorial production. Claims remain atomic, verifiable statements; Experience Blocks preserve how a traveler acts on those statements.

## Data contract

`experience_extraction_runs` binds one run to a Source capture version and deterministic input hash. A succeeded run supersedes older succeeded runs only when the input hash changes. `experience_blocks` stores a typed block plus its route sequence, decision logic, conditions, tradeoffs, warnings, alternatives and provenance IDs.

Allowed block types are route strategy, process sequence, decision logic, tradeoff, condition, warning, alternative and practical pattern. Every stored block must reference at least one valid Segment and at least one Claim or Evidence Span from the same extraction package. Invalid IDs are discarded; an ungrounded block is never persisted.

Media durability and Experience quality are separate dimensions. A package can be marked degraded when historical media is unavailable, but it may not invent the missing observation.

## Pipeline position

```text
Source → Segments → Claims → finalize extraction → Experience
       → source-family / blueprint / diagnostic → Knowledge event
```

When AI is not configured, the stage records an empty grounded result so the durable pipeline can continue. A later backfill may re-run eligible Sources with the configured model.

Editorial Assembly explicitly selects Experience Block IDs. Narrative Plan decides where those blocks help explain sequence, conditions or tradeoffs. Writing Packet renders only the selected content and IDs; it never promotes an Experience statement into Knowledge unless a separate Claim supports that fact.

## Reprocessing

Run `npm run backfill -- experience` to preview eligible Sources. Execute with `npm run backfill -- experience --execute`. The run is recorded as queued until all listed Sources have a succeeded Experience run; terminal missing results mark the backfill failed without modifying Claims or Knowledge.

Re-extraction is idempotent by Source and input hash. Existing succeeded blocks remain available until the replacement run succeeds.
