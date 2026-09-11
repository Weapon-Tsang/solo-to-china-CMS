# Failure and production lifecycle

## Opportunity states

Actionable opportunities begin as `recommended` (or return as `recommended_again`). An editor may independently approve, defer or ignore each item. Approval changes the state to `approved`; evidence-ready work moves through `producing` to `finished`. Evidence-incomplete approval remains durable and resumes only when a Knowledge rebuild makes the coverage ready.

`SOURCE_ADAPTATION`, `TOPIC_FEATURE` and `MULTI_SOURCE_SYNTHESIS` are parallel production modes. Approving one path does not consume the others.

## Terminal production failure

A bounded, non-system production failure creates one `failure_lessons` record containing the normalized reason, failing stage, prior inputs and remediation rule. The same transaction:

- cancels other active jobs for that production attempt;
- deletes transient Brief, Draft, Narrative, Writing Packet, page, visual and delivery descendants through foreign-key cascades;
- preserves Sources, capture versions, media originals, Segments, Evidence Spans, Claims, Knowledge, Experience, editorial lessons and Golden Articles;
- records the removal/preservation result in `production_rollbacks`;
- resets the candidate and returns the opportunity to `recommended_again` with its previous failure visible.

The editor must approve the opportunity again. A generic retry endpoint cannot bypass this gate.

Database corruption/unavailability, credentials, provider quota, network and lease faults remain operational exceptions. A source-media fault marks the Draft `media_pending` and queues repair without rewriting valid prose. Ordinary learned content failures do not remain in the system exception inbox.

## Published content impact

When a Claim or Knowledge change affects a published WordPress record, the system creates a durable impact plus an `UPDATE` opportunity. It never changes the live post. Topic overlap is shown as `UPDATE`, `EXPAND` or `MERGE`; a new topic is `NEW`, and an explicit editorial non-action is `SKIP`.

## Editorial feedback

Draft feedback produces reusable `editorial_lessons`. “很好” or another explicitly successful result may be saved as a `golden_articles` reference. These records guide later Assembly and Writing Packets while retaining their source Draft and revision; they are not copied wholesale into a new article.
