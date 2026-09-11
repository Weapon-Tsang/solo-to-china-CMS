# Favorites Sync intake interpretation

This operational note applies the active Content Production Strategy 3.0 to Xiaohongshu Favorites Sync. It does not create a new strategy version or change the editorial approval gate.

## Selection and authorization

A favorite is the owner's explicit selection that a Source belongs in the SoloToChina Research Evidence Pool. For `xhs_favorites_sync` and the existing `xhs_manual_extension` fallback, it also records owner-confirmed commercial use, copying/download, editing/cropping/format conversion, redistribution, derivative, translation, publication, WordPress Media, and official marketing permission for the full Source and captured media.

The capture retains Source and media provenance. Other acquisition origins keep their independent authorization status and do not inherit this permission.

## Editorial boundary

Favorites Sync ends at durable Source intake. Structured extraction, Claims, Knowledge, coverage analysis, and Recommendations continue through the existing pipeline. Only an explicit human **Approve article** decision may start planning and production. A favorite does not bypass Recommendation approval, QA, commercial isolation, or draft-only WordPress delivery.

## Evidence completeness

Concurrency and provider limits are batch limits. They cannot become Source-total limits. Raw text/DOM, text segments, all discovered images, and all discovered videos remain represented. Partial captures cannot be treated as processed. Provider output exhaustion subdivides evidence and retries without silently dropping the remainder.

## Media durability and sync modes

Every discovered authorized image or video must be uploaded as verified original bytes before extraction. The extension records original size, SHA-256, MIME and a server-issued `media/...` storage reference; a thumbnail or AI derivative is recorded separately and never satisfies durability. The CMS exposes media discovery, durability, AI readability and extraction as separate states.

- Incremental Sync processes only newly discovered favorite identities.
- Repair Sync requests the CMS repair manifest and revisits only known notes with missing originals, incomplete capture or an explicit browser-repair action.
- Full Historical Sync walks the complete visible history and includes both new intake and repair work.

The browser queue is durable and resumable. A remote URL that the server can fetch is repaired server-side first. Authentication, expired CDN URLs, hash mismatch or unsupported bytes become explicit browser/manual repair outcomes rather than silent success.
