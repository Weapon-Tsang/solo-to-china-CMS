# V1 Acceptance

- [x] A user explicitly opens and saves one Xiaohongshu note; there is no automated discovery or crawling.
- [x] Raw capture remains safe when AI or WordPress is not configured.
- [x] Multiple sources become Claims, KB Facts, conflict states, and editorial patterns automatically.
- [x] Topic generation requires multiple independent sources and blocks WordPress cannibalization.
- [x] Itinerary generation requires route/timing evidence from multiple sources.
- [x] Stale facts cannot pass deterministic QA; time-sensitive facts require verification notes.
- [x] Research Drafts never read affiliate inventory.
- [x] Commercial composition cannot mutate the Research Draft or Knowledge Base.
- [x] WordPress delivery is always `draft` and cannot overwrite a human-published post.
- [x] Existing WordPress content is synchronized read-only.
- [x] Human attention is concentrated in final publish review and the unified Exceptions view.
- [x] Non-loopback operation requires separate capture/admin tokens.
- [x] SQLite backups are consistent, checksummed, retention-managed, and independently verifiable.
- [x] Job latency/outcome telemetry and structured request logs make unattended operation observable.
- [x] Optional exception webhooks are durable, deduplicated, HTTPS-only, and require no manual exception list.
- [x] A backup can be restore-drilled into an isolated temporary database without touching live data.
- [x] Package, API, and Chrome extension versions remain aligned for every release.
