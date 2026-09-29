# 扩展固定身份与来源配置发布

用户明确授权“发布到生产，并且修改机制”。2026-09-29 16:43:10 Asia/Shanghai 完成配置切换，API维护3.5秒，Worker容器及启动时间不变。继续使用2.0.72镜像sha256:3fe1cc4459a4346a753f4ffa88a36845e63a5c1e107e173f8172e2a165418d80。旧API保留engine-before-stable-20260929；原环境文件私有保存在/opt/solo-to-china/config-releases/extension-origin-stable-20260929。

允许来源：旧fhgmkgadfofhhmjmjfojajhnnhdjjgin、用户当前deeckbbjmgolnfjcffffeehgceghehgi、固定jjcdhgnlpbodpfjfnkgpcpmfjiaidmfn。两新增来源有效令牌空身份查询200、OPTIONS204且精确允许Origin、无效令牌401；未列入来源403。engine/capture域名ready均200且version2.0.72。

机制：manifest.key固定公开SPKI身份，不是采集凭据；Chrome通过其维持扩展ID（https://developer.chrome.com/docs/extensions/reference/manifest/key）。打包器校验固定ID，缺失或重新生成key时拒绝打包。两个不同目录产物ID一致。后续更新应保留key且不卸载扩展。旧无key安装首次切换是身份迁移，可能需重新保存令牌；之后无需因解压目录变化再次修改服务端白名单。此次未扩大为任意来源，也未更改一般生产部署授权规则。

风险分类LOCAL_LOGIC/配置；交付output/SoloToChina-2.0.72-stable-identity.zip（包含笔记跳转修复），SHA256 163a726a1e4a589d235585e17cfe01e349c5ee2ca95ac34542c53e7054e52045，不含凭据。

- L1: PASS，身份门禁测试2项、标签控制15项。
- L2: PASS，上一轮相关53项，新增身份打包回归2项。
- L3: NOT REQUIRED，未修改数据库或持久化语义。
- L4: NOT TESTED，真实Chrome固定身份安装及收藏入库尚待用户验证；打包测试不等于浏览器E2E。
- L5: NOT REQUIRED，未调用Provider。
- L6: NOT TESTED，本次仅既有镜像配置切换，未执行全流程生产重放。
- Post-Fix Exploratory Audit: PASS，域名ready、两新增来源鉴权正负边界、非授权来源拒绝、Worker连续运行。

没有执行Cloud Build、生产数据库备份/迁移、模型调用、WordPress写入或git提交推送。
