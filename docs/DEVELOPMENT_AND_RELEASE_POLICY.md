# SoloToChina Development and Release Policy

本项目默认使用 DEVELOPMENT 模式。

开发和测试不等于生产发布。

日常修改必须优先在本地进行。

推荐流程：

修改
→ 定向测试
→ 本地运行
→ 真实生产数据库副本测试
→ 必要时真实 API 小范围测试
→ 用户确认
→ commit / push
→ 用户明确授权生产部署
→ RELEASE

生产部署区分：

1. CODE_ONLY_RELEASE
2. DATA_MIGRATION_RELEASE

详细执行规则以根目录 AGENTS.md 为最高项目约束。