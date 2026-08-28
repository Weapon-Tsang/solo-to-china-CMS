# Content strategy versions

`config/content-strategy.json` is the single machine-readable source of the active strategy. The backend reads it at startup and exposes it through the system API; the dashboard consumes that API value.

Strategy specifications are append-only in practice. A strategy change requires a new versioned specification, a manifest update, new generated records tagged with that version, updated handoff material, tests, and `npm run release:check`. Never rewrite a historical strategy file to represent a later version.
