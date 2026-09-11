# Backoffice information architecture

The dashboard has exactly six top-level business areas:

| Area | Operator question | Primary records |
| --- | --- | --- |
| 来源 | What did we capture, and is it complete? | Sources, capture/media status, extraction, Experience |
| 建议 | Which actionable article opportunities need a decision? | Opportunity inbox, readiness, SEO action, previous failure |
| 内容 | What happened to approved production? | candidates, Briefs, Drafts, QA, delivery state |
| 知识库 | What current evidence can the system use? | Claims-derived Knowledge, consensus, visibility |
| 商品 | What commercial assets can be composed after QA? | providers, affiliate assets, queues, performance |
| 设置 | How is the system configured and maintained? | health, WordPress, exceptions, backfills, lessons, golden articles |

Technical modules are deliberately nested under Settings rather than becoming navigation items. This includes system health, jobs, migrations, backfills, Favorites Sync history, media repair, Experience status, Failure Lessons, Golden Articles, WordPress configuration and frontend-contract diagnostics.

The Recommendations area is not a source-diagnostic log. It receives only durable, actionable content opportunities. Low-value, knowledge-only and research-gap diagnostics remain available through Source detail or Settings diagnostics.

The Content area follows approved work and exposes the minimum recovery action. It does not duplicate the Suggestions inbox and does not provide a hidden path around reapproval after failure.
