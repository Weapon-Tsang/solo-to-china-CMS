# 2026-09-29 收藏同步连接故障

## 令牌填写后的第二个阻断：扩展 Origin 白名单缺失

用户填写现有令牌后仍被拒绝。进一步只读取正式engine的指定环境项，确认 `CAPTURE_ALLOWED_ORIGINS` 未设置。以现有有效令牌对原capture域名执行空身份查询：不带Origin时200；加入明确为合成控制样本的 `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` 时403，响应 `Request origin is not allowed.`。两次查询均为items=[]，不会写入来源或创建采集任务。控制Origin不冒充用户的实际扩展ID；实际ID仍待用户提供。

此前无Origin的200不能证明真实Chrome扩展能使用该令牌成功访问。`classifyCaptureApiError` 又将所有401/403均映射为CAPTURE_UNAUTHORIZED，导致服务器拒绝来源时仍误报令牌错误。现已区分CAPTURE_ORIGIN_DENIED，提示精确来源配置，并暂停而不重试采集；最终扩展相关回归51项通过。

此问题的实际恢复需要用户当前32位扩展ID，随后按精确 `chrome-extension://<ID>` 配置生产允许来源并使API进程读取新配置。尚未改变生产配置或重启服务，不开放通配来源，不通过移除Origin绕过检查。现有令牌无需因此轮换；具体生产配置动作须形成有界方案并获授权。当前真实扩展同步仍为NOT TESTED / 未确认恢复。

本次为 DEVELOPMENT，改动分类 LOCAL_LOGIC + 扩展状态提示；没有新生产部署、commit/push、Cloud Build、模型调用或正式CMS数据写入。

用户截图及文字确认：CMS地址为 `https://capture.solotochina.com`，采集令牌显示“请输入”。因此当前扩展没有保存令牌；同步入口的空身份查询在创建会话/扫描收藏夹之前被鉴权拒绝。此前云端包使用 `--preserve-stored-token`，不内嵌令牌，也无法把另一个扩展身份的storage自动迁入新扩展。无法仅凭这些证据断言用户是否更换过加载目录。

另复现确定的提示Bug：`command()`显示错误后，下一次每秒GET_STATE刷新会把没有session的弹窗重新画成“等待采集指令”。这造成同步失败看起来像没有响应。

修复范围：

- 云端地址没有令牌时，本地明确报CAPTURE_TOKEN_MISSING，不发网络请求、不创建扫描会话。
- 鉴权/连接预检失败只持久化错误码和时间；轮询与重新打开弹窗保留错误，不保存凭据或服务端原始错误正文。
- 自动展开连接设置；检查期间显示正在验证；成功设置后清空密码输入框，空白密码输入仍保留原令牌。
- 增加“检查已保存的连接”，使用现有空身份查询，只验证连接，不创建采集任务。成功时清除历史连接错误。
- 打包时附INSTALL.md，说明旧配置保留范围、新扩展首次配置及原目录覆盖更新方式。

验证：

| 层级 | 状态 | 范围 |
|---|---|---|
| L1 Targeted Tests | PASS | 新增7项，覆盖空令牌、401与Origin 403区分、轮询/重开、保存/保留令牌、无采集连接检查及检查中状态 |
| L2 Module Regression | PASS | 最终51项非重复扩展/同步模块测试；修改JS语法和diff检查通过 |
| L3 Production DB Replay | NOT REQUIRED | 不修改数据库或后台Pipeline |
| L4 Browser E2E | PASS（隔离弹窗范围） | Chrome实际点击同步→401错误→重载后保留→填写合成令牌→保存→独立检查200；真实popup代码、真实background处理器、假Chrome存储及仅本地HTTP认证端点 |
| L5 Real Provider Canary | NOT REQUIRED | 不涉及模型 |
| L6 Full Production Replay | NOT REQUIRED | 不发布CMS，不更改后端生产链 |
| Post-Fix Exploratory Audit | PASS（定向范围） | 空密码不覆盖旧令牌、GET_STATE不暴露令牌、连接检查不创建会话/新tab、已有暂停恢复模块回归 |

**NOT TESTED：** 用户实际安装的MV3扩展更新、用户填入现有生产令牌后的鉴权和真实收藏入库。浏览器工具安全策略禁止访问扩展管理页，未尝试其他方式绕过。用户需要在现有扩展填写令牌；没有将本地UI模拟成功宣称为真实生产采集成功。

修复包：`output/SoloToChina-2.0.72-connection-fix.zip`，最终SHA256 `d9a16e1b5867a53251ca089a5c8f5a23f4b89f33c6875fe7b5ab1cfe7df5b0c6`，不内嵌凭据。保持应用/扩展版本2.0.72，仅修复本地扩展连接提示；建议覆盖原加载目录后重新加载。填写令牌只解决凭据缺失，当前还需补齐上文确认的生产Origin白名单，不能再宣称只填令牌即可恢复。

本机证据：`output/extension-connection-tests.log`、`output/extension-connection/browser-events.json`、`output/extension-connection/browser-connection-check.png`、`output/extension-connection/package.json`。测试夹具 `scripts/extension-connection-fixture.mjs` 仅允许本地网络，所有令牌和收藏夹均为合成数据。
