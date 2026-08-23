# V1 Delivery Roadmap

## Delivered foundation

- [x] Xiaohongshu manual Chrome capture adapter
- [x] Raw text/DOM/image-reference storage
- [x] Canonical URL dedupe and source revisions
- [x] Durable local job queue and bounded retries
- [x] Optional multimodal AI structured extraction
- [x] Claims with evidence and uncertainty
- [x] Source Blueprint extraction
- [x] Destination KB aggregation and conflict preservation
- [x] Editorial Blueprint Library aggregation
- [x] Minimal status/exception dashboard
- [x] Commercial/Research schema boundary
- [x] Evidence-threshold automatic topic candidates
- [x] Evidence-backed content brief planner
- [x] Original English draft generator with evidence ledger
- [x] Independent model QA plus deterministic hard gates
- [x] One automatic revision before human exception
- [x] WordPress draft-only idempotent adapter
- [x] Protection against overwriting a human-published WordPress post
- [x] Typed Commercial Offer ingestion boundary
- [x] Non-invasive Commercial Composition snapshots
- [x] Relevance/category dedupe and affiliate disclosure
- [x] No-offer pass-through behavior
- [x] Attraction/how-to topic candidates

## Delivered vertical slice: research to WordPress draft

1. **Automatic topic candidates** — delivered
   - Derive gaps from KB coverage, conflict state and Source Blueprint clusters.
   - Rank for Solo Traveler / first-time / non-Chinese utility.
   - Do not use affiliate inventory in ranking.

2. **Content brief planner** — delivered
   - Select only evidence-backed Knowledge Facts.
   - Carry conflict notes, freshness and internal Source citations into the brief.
   - Add foreign-traveler adaptation requirements: language barriers, payments, maps, booking, safety and solo logistics.

3. **Original English draft generator** — delivered
   - Synthesize across multiple Sources; never translate one note section-by-section.
   - Keep an internal evidence ledger from paragraphs to Claims.
   - Block generation when critical coverage is single-source or conflicted without a caveat.

4. **Independent quality review** — delivered
   - Evidence coverage, contradiction handling, originality, SEO/GEO structure, foreign-traveler usability, temporal sensitivity and unsupported claims.
   - Failed checks return to generation automatically; only persistent ambiguity enters the human exception queue.

5. **WordPress draft-only adapter** — delivered
   - Use an Application Password with least privilege.
   - Create/update `draft` only; never publish automatically.
   - Idempotency key maps internal Draft to WordPress post ID.
   - User retains the final publish decision.

## Next vertical slice

1. **Commercial Composer** — delivered
   - Runs only after the Research Draft passes QA.
   - Adds typed slots for hotels/tickets/trains/flights/tours/transfers/planner.
   - Cannot mutate the Research Draft evidence ledger or Knowledge Base.

2. **Topic strategy expansion** — partially delivered
   - Attraction/how-to clusters delivered; itinerary clusters remain.
   - Coverage freshness, seasonality and official-source verification gates.
   - Cannibalization checks against existing WordPress content.

3. **WordPress field mapping**
   - Confirm production SEO plugin fields, taxonomy IDs, author, featured-media and block markup.
   - Keep every new post in `draft` regardless of field mapping.

## Operational hardening before remote deployment

- TLS + admin authentication at reverse proxy.
- Encrypted secret storage and key rotation.
- SQLite backup/restore check and retention policy.
- Asset archival policy after permissions/legal review.
- Structured logs, job latency metrics and exception notification.
- Schema migration runner beyond migration 1.
