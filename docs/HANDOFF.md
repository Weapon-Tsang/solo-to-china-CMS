# Project handoff

## Active Content Strategy

- **Active strategy:** SoloToChina Content Production Strategy 1.0
- **Canonical manifest:** `config/content-strategy.json`
- **Specification:** `docs/content-strategy/CONTENT_PRODUCTION_STRATEGY_1.0.md`
- **Status:** implemented incrementally on the existing durable SQLite pipeline; legacy records intentionally have no retroactive strategy tag.

Any future maintainer, agent, or developer must read the active manifest and linked strategy specification before changing intake, recommendations, content planning, image behaviour, QA, or publishing.

## Current operating boundary

Source discovery stays human-led. The Chrome extension only captures a note the user has opened and explicitly saved. The engine stores raw evidence, creates traceable structured claims, asks for a human decision before article planning, sends only validated drafts to WordPress, and never publishes a post itself.
