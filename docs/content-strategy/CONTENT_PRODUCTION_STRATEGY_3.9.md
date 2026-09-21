# SoloToChina Content Production Strategy 3.9

Strategy 3.9 inherits the evidence, ownership, independent text review, required-media manifest, delivery gate, and durable recovery rules of Strategy 3.8.

## Original source photography

Use as many relevant, distinct source originals and real-world photographs as the article and Frontend Contract can use well, up to the configured article visual limit. Include useful Chinese information graphics, route maps and editorial cards for complete English translation; generate illustrations when they add real value. No one visual type has blanket priority. Images must match the described place, object or action; retain source attribution, accurate English alt text and any necessary caption. Do not pad the page with unrelated files or fabricate documentary scenes.

Direct reuse of a downloaded source original is a local file operation. Selection, quality screening, hashing, placement and reuse of that original must make zero model or image-generation API calls. Translation of Chinese graphics, necessary generation and independent visual QA remain required, use their existing durable budget, and are counted separately. Other source extraction and the article's independent text QA also remain separately accounted for. The cost ledger must not label local photo reuse as a paid model call.

Each original is screened locally using its saved bytes: SHA-256, decode, resolution, focus and visual detail, plus local OCR for dense Chinese text. A photograph with low quality, large Chinese text regions, a mismatched hash, missing bytes, or uncertain subject relevance enters review and cannot satisfy a required media slot. Store counts and reasons, not the OCR text. Reuse a qualified audit only while its recorded SHA-256 equals the current original. Never substitute a source image that was not saved or is inaccessible.

## Historical article image refresh

Inventory current unpublished and published articles against the same photo rule. Preserve approved article prose and completed media artifacts. Repair only missing or unsuitable visual slots and their dependent page, media-delivery and WordPress stages. A changed visual plan requires a new manifest. Reuse the independent text review only when the article body and evidence hashes are unchanged; newly translated or generated visuals still require independent visual QA. Delivery rechecks the live database and file hashes. For published posts, reconcile the actual WordPress status and current page identity before updating media; maintain the published status and record a verified receipt. An uncertain remote outcome requires review before any retry.

Backfills are bounded and resumable. Preview the affected articles and proposed image changes, including which slots require paid translation, generation or QA, before dispatch. Do not skip valuable graphics to save a call. Do not claim historical articles have been refreshed until their actual WordPress delivery and verification complete.

## 不变的安全边界

事实与来源必须可追溯；必需配图不齐时保留正文并阻断 WordPress 文章交付。缓存不能代替当前修订、媒体文件、预算和配额的权威检查。已成功正文、图片与审核回执按内容哈希复用；不明远端结果先核对再恢复。
