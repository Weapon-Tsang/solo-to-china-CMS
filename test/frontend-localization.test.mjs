import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { friendlyError, label, formatDuration } from "../frontend/src/lib/utils.js";

const appSource = fs.readFileSync(new URL("../frontend/src/App.jsx", import.meta.url), "utf8");
const viewsSource = fs.readFileSync(new URL("../frontend/src/views.jsx", import.meta.url), "utf8");
const dialogSource = fs.readFileSync(new URL("../frontend/src/components/ui/dialog.jsx", import.meta.url), "utf8");
const interfaceSource = `${appSource}\n${viewsSource}\n${dialogSource}`;

test("CMS detail and workflow controls remain localized in Chinese", () => {
  const requiredChinese = [
    "来源详情",
    "打开原文",
    "重新提取",
    "核验为官方来源",
    "标记为未核验",
    "信息主张",
    "文章草稿",
    "读者正文（Markdown）",
    "内部证据台账",
    "商业内容层",
    "实体身份审核",
    "前端能力契约",
    "目的地知识地图",
    "联盟资产建链队列",
    "处理队列",
    "冷却等待",
  ];
  const obsoleteEnglish = [
    "Source detail",
    "Open original",
    "Re-run extraction",
    "Verify as official",
    "Mark unverified",
    "Processing failure",
    "Article draft",
    "Reader-facing Markdown",
    "Internal evidence ledger",
    "Commercial overlay",
    "Entity Identity Review",
    "Frontend Capability Contract",
    "Destination knowledge map",
    "Affiliate Asset Queue",
  ];

  for (const text of requiredChinese) assert.ok(interfaceSource.includes(text), `缺少中文界面文本：${text}`);
  for (const text of obsoleteEnglish) assert.equal(interfaceSource.includes(text), false, `仍存在旧英文界面文本：${text}`);
  assert.ok(viewsSource.includes("item.list_number"), "来源标题必须显示当前列表序号");
  for (const text of [
    "系统为什么拦住这条信息？",
    "系统为什么拦住这两条信息？",
    "原意丢失：重新提取",
    "语义完整：关闭误报",
    "确实矛盾：选择最终事实",
    "可以同时成立：关闭误报",
    "采用这条作为最终事实",
    "保存为最终事实",
  ]) assert.ok(viewsSource.includes(text), `人工判定界面缺少大白话说明：${text}`);
});

test("shared status, category, and duration labels use Chinese display text", () => {
  assert.equal(label("paragraph_group"), "段落组");
  assert.equal(label("READY_FOR_MANUAL"), "等待人工建链");
  assert.equal(label("airport_transfer"), "机场接送");
  assert.equal(label("manual_review"), "需要人工检查");
  assert.equal(label("extracted"), "已提取，等待审计");
  assert.match(friendlyError("Coverage audit still found material evidence without Claims after one targeted retry."), /覆盖审计/);
  assert.equal(formatDuration(61_000), "1 分钟");
});
