# Commercial B v4.1 — CMS release ledger (2026-09-21)

Risk class: LOCAL_LOGIC / cross-repository rendering contract. Code-only release; database schema remains 73. Existing WordPress identities, article bodies, media, affiliate URLs and attribution are preserved.

| Acceptance | Evidence | Boundary |
| --- | --- | --- |
| Historical copy and old/new cards | Targeted commercial regression includes nonempty historical disclosure, generated TOUR_ACTIVITY title/filler, and preservation of manual copy. CMS now emits human category labels and page-level relationship text. | Runtime display of production drafts still needs post-deployment browser check. |
| Frontend contract | Fixed frontend commit `293ea96623da674b7d7ea9b8adcdb83f23878d75`; working-tree and fixed-SHA cross-repo gates PASS. | No production WordPress write in local testing. |
| Local end-to-end | Isolated CMS SQLite and WordPress Playground: CMS preview button opens current local draft #40, not production WordPress. Child/parent theme and Tools assets load locally. | Preview data is marked TEST DATA; paid model not invoked. |
| Production shape, read-only | Eleven synced production WordPress drafts have eighteen commercial placements. Three active assets lack explicit discount and reviewed campaign validity. | Numeric production discount is ineligible pending verified offer target, rules and expiry; no invented percentage. |
| Release gate | `npm run check`, `npm test` 753/753, `npm run release:check` 50 mandatory PASS, 0 failures; frontend `verify-upgrade.ps1` PASS. | The offline gate does not prove public-live WP theme installation, paid model output, SEO ranking or historical data repair. |

Validation: L1 PASS, L2 PASS, L3 read-only production shape audit PASS (full DB replay NOT TESTED), L4 local browser and CMS→WP PASS, L5 NOT REQUIRED, L6 offline release gate PASS (full production-like pipeline replay NOT TESTED), exploratory adjacent commercial audit found no verified numeric campaign assets. No production database migration or backfill is planned.
