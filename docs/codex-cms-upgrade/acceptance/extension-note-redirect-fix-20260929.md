# 收藏夹笔记跳转误暂停修复

用户确认没有关闭标签，新增笔记正常打开，而扩展显示采集页已关闭、已采集0。页面采集器优先保存收藏夹的 /board/collection/note 链接；实际截图已进入 /explore/note。原 tabMatches 要求路径一致，后台 onUpdated 因而调用 paused_tab_closed。

已通过真实 background 事件处理器的隔离测试复现：发送同一笔记的 URL 更新事件后，旧代码把 running 改为 paused_tab_closed。修复只允许 worker 标签在同一 HTTPS 小红书 origin 内按精确笔记 ID 匹配 board、explore、discovery/item 三类路径；标签 ID、窗口 ID、发现页范围约束继续生效。跨站、协议变更、其他笔记和登录页不被认可。

风险：LOCAL_LOGIC（浏览器标签识别，影响采集流程）。没有修改服务器、数据库、队列结构或历史数据。

- L1 Targeted Tests: PASS，新增2项先失败后通过。
- L2 Module Regression: PASS，53项，包含导航事件、主动关闭清理、暂停/恢复、MV3恢复、连接及收藏队列回归。
- L3 Production DB Replay: NOT REQUIRED，本次不修改服务端或持久化数据语义。
- L4 Browser E2E: NOT TESTED，尚未在用户实际扩展中加载新文件并采集；隔离事件测试不替代真实采集。
- L5 Real Provider Canary: NOT REQUIRED。
- L6 Full Production Replay: NOT REQUIRED，本次本地扩展修复包，未发布服务端。
- Post-Fix Exploratory Audit: PASS（同笔记重定向及清理、不同笔记/域名/协议、发现页范围）；真实采集入库仍NOT TESTED。

交付 output/SoloToChina-2.0.72-note-redirect-fix.zip，不内嵌凭据。必须覆盖原加载目录并重新加载，保持扩展 ID fhgmkgadfofhhmjmjfojajhnnhdjjgin；新目录安装可能改变 ID 和丢失原设置。更新后回到收藏夹点击继续同步。尚未确认新来源入库，不宣称生产采集已完全恢复。
