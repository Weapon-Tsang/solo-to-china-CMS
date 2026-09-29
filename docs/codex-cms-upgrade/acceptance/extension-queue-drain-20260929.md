# 小收藏夹队列饥饿修复

截图为发现2、已存在1、新增1、已采集0、排队1，DISCOVERY_STALLED暂停。原discoverWindow仅在明确结束或queueHighWatermark（默认500）到达时进入acquisition。无明确结束提示的小收藏夹会反复扫描并最终暂停，已发现任务不能执行。

改为每批发现待处理任务即进入acquisition；已有排队任务恢复时直接进入acquisition。处理完后如未确认结束则继续发现。保留原结束确认条件，不把停滞误记为成功同步。此修复不保证缺少结束标记的收藏夹自动标记完成，但防止已发现来源被扫描阻塞。

风险PIPELINE（客户端调度，无schema及服务端修改）。L1/L2 PASS：46项，新增真实background函数两卡一新增场景与旧排队恢复场景。L3 NOT REQUIRED：不涉及服务端数据库逻辑；已覆盖持久化队列恢复fixture。L4 NOT TESTED：真实Chrome采集及CMS入库尚未确认。L5 NOT REQUIRED；L6 NOT TESTED；Post-Fix Exploratory Audit PASS（相关暂停/恢复、MV3恢复、去重、结束确认及固定身份测试）。未因单元测试通过宣称真实入库已恢复。

交付output/SoloToChina-2.0.72-queue-drain-fix.zip，固定ID仍jjcdhgnlpbodpfjfnkgpcpmfjiaidmfn，无内嵌令牌，无需修改服务器白名单。覆盖当前固定身份版目录后重新加载，再继续同步。未执行生产发布、数据库写入、Provider或WordPress调用。
