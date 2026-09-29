# 当前扩展精确来源配置发布方案（已批准并完成）

2026-09-29 16:00:02（Asia/Shanghai）完成配置发布。API维护3.77秒；沿用2.0.72不可变镜像，Worker容器ID及启动时间保持不变。旧API保留为`engine-before-origin-20260929`，私有原配置保存在服务器`/opt/solo-to-china/config-releases/extension-origin-fhgmkgad-20260929`。

上线验收：engine与capture域名`/api/ready`均200、ready=true、version=2.0.72；实际扩展Origin预检204且Access-Control-Allow-Origin精确匹配；实际Origin与现有有效令牌空身份查询200；无效令牌401；其他扩展Origin403。没有创建采集任务或执行模型调用。

覆盖状态：L1定向测试PASS；L2扩展模块回归PASS（51项，另有真实HTTP边界测试1项PASS）；L3生产DB重放NOT REQUIRED（配置变更）；L4隔离popup交互PASS，用户实际MV3收藏同步NOT TESTED；L5真实Provider NOT REQUIRED；L6完整生产重放NOT TESTED（本次仅同镜像Origin配置切换）；Post-Fix Exploratory Audit PASS（域名ready、鉴权正负边界、Worker连续运行）。尚不能据此宣称实际收藏已成功入库。

用户提供扩展ID：`fhgmkgadfofhhmjmjfojajhnnhdjjgin`。

已验证：当前engine没有CAPTURE_ALLOWED_ORIGINS；使用现有生产CAPTURE_TOKEN与该精确Origin，对capture域名提交空身份查询返回403 / `Request origin is not allowed.`。同一令牌、不带Origin返回200。查询items=[]，不会创建来源或Job。不要继续轮换令牌。

唯一配置增量：

```dotenv
CAPTURE_ALLOWED_ORIGINS=chrome-extension://fhgmkgadfofhhmjmjfojajhnnhdjjgin
```

目标：既有project `project-4bcb9146-c37b-43b0-b11`，VM `solo-to-china-engine`，zone `asia-east1-b`，`/opt/solo-to-china/.env.production`及API容器engine。使用当前固定2.0.72镜像 `sha256:3fe1cc4459a4346a753f4ffa88a36845e63a5c1e107e173f8172e2a165418d80`；Worker、Cloudflared、数据库、媒体、令牌、模型预算与域名不变。

执行前：只读检查实际容器镜像、角色、网络、挂载与启动参数；若与上述既有发布身份不符则停止。保存私有环境文件原件和容器配置（含凭据的文件只保留0700目录，不输出或提交）。确保只新增这一项，不重复定义、不加入通配符；若期间已有其他合法Origin则保留并单独核对。

批准后：原API正常停止，保留旧容器并暂停其自动重启；用相同镜像、原有环境和挂载重建API，仅改变上述允许来源。保留CMS_PROCESS_ROLE=api及CMS_STARTUP_RECONCILIATION_ENABLED=false；API角色不执行schema迁移。先在隔离网络启动并检查ready，再连接原solo-to-china网络恢复服务。沿用已有仅恢复容器的开机脚本。Worker不中断。

单次API维护窗口最多2分钟；约定正向检查预算60秒，失败立即停止新API并恢复原容器及环境文件，余下60秒用于恢复。恢复只切换同版本API及其配置，不回退数据库。超出预算不继续新的维护尝试。

验收：原域名ready/version；实际扩展Origin的OPTIONS预检；实际Origin+有效令牌空身份查询200；实际Origin+无效令牌401；另一个合成Origin仍403。只做空查询，不触发采集、Provider或WordPress写入。最终真实收藏同步由用户在现有收藏夹操作验证；这一步未执行不得宣称已成功入库。

本地真实HTTP服务测试 `test/extension-origin-access.test.mjs` 已通过，覆盖上述正负认证边界及sources/jobs/model_call_metrics均为0。扩展错误提示已有51项相关测试通过，Origin拒绝不再应被报告为令牌无效。

未执行Cloud Build、镜像发布、数据库备份/迁移或Worker重建。用户批准本具体配置发布后执行；上述结果为实际上线验证。未提交或推送本地修复。
