import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { label, formatDuration } from "../frontend/src/lib/utils.js";

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
});

test("shared status, category, and duration labels use Chinese display text", () => {
  assert.equal(label("paragraph_group"), "段落组");
  assert.equal(label("READY_FOR_MANUAL"), "等待人工建链");
  assert.equal(label("airport_transfer"), "机场接送");
  assert.equal(formatDuration(61_000), "1 分钟");
});
