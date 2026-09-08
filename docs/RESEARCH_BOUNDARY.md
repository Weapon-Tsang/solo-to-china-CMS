# Research / Commercial Boundary

## Invariant

Affiliate 是发布阶段的 Commercial Layer，不能改变哪些 Source 被保存、哪些 Claim 被抽取、冲突如何判定，或 KB 选择什么作为 preferred value。

Favorites Sync is a Research intake transport. A favorite means “include this Source in the evidence pool” and never means “write or publish an article.” Recommendation approval remains the only article-production decision.

For `xhs_favorites_sync` and `xhs_manual_extension`, the project owner has confirmed commercial-use, editing, redistribution, derivative, and publication rights for the complete captured Source and media. The system records this authorization and full provenance on Sources, Capture Versions, and Assets. Other acquisition origins retain independent rights semantics and cannot inherit this status merely because their content resembles a favorite.

## Allowed data flow

```text
Research Sources → Claims → Knowledge → Research Draft
                                             │
Commercial Offers ───────────────────────────┤ explicit placement slots
                                             ▼
                                      Publishable Draft
```

禁止反向数据流：

- Offer/commission 不进入 Source quality score。
- Commercial conversion keyword 不进入 Claim extraction prompt。
- Trip.com availability 不能成为 Destination KB 的“事实佐证”。
- Affiliate link 不进入 Raw Source、Claim、Knowledge Fact 或 Source Blueprint。
- 没有合适 Offer 时，Research Draft 必须仍然完整、准确、可发布。

代码层通过表族和 Repository 查询隔离来执行这个约束。Commercial Composer 已作为 QA 后的独立阶段实现：它读取冻结的 Research Draft 和 typed Offers，只写 `commercial_compositions`。测试断言 Topic Package 和 Research Draft 均不包含 Offer 数据。
