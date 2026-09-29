import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { validateExtensionIdentity } from './lib/extension-identity.mjs';

const argumentsMap = new Map(process.argv.slice(2).flatMap((value, index, values) => value.startsWith("--") ? [[value, values[index + 1]]] : []));
const origin = normalizeOrigin(argumentsMap.get("--origin"));
const tokenFile = argumentsMap.get("--token-file");
const captureToken = readCaptureToken(tokenFile);
const preserveStoredToken = process.argv.includes('--preserve-stored-token');
const output = path.resolve(argumentsMap.get("--out") || "output/extension-cloud");

if (!origin || (!captureToken && !preserveStoredToken)) {
  console.error("Usage: node scripts/package-extension-cloud.mjs --origin https://capture.example.com (--token-file <private-file> | --preserve-stored-token) --out <new-directory>");
  process.exit(1);
}

const root = path.resolve("extension");
const extensionId = validateExtensionIdentity(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
if (fs.existsSync(output)) throw new Error(`Extension package target already exists: ${output}`);
fs.cpSync(root, output, { recursive: true, errorOnExist: true });
const manifestPath = path.join(output, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [
  ...manifest.host_permissions.filter((value) => /^https:\/\/\*\.(?:xiaohongshu|xhscdn)/.test(value)),
  `${origin}/*`,
];
manifest.name = "保存到 SoloToChina";
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const popupPath = path.join(output, "popup.js");
const originalPopup = fs.readFileSync(popupPath, "utf8");
if (!preserveStoredToken) {
  const popup = originalPopup
    .replace('const DEFAULT_ENDPOINT = "http://127.0.0.1:4310";', `const DEFAULT_ENDPOINT = ${JSON.stringify(origin)};`)
    .replace('const DEFAULT_CAPTURE_TOKEN = "";', `const DEFAULT_CAPTURE_TOKEN = ${JSON.stringify(captureToken)};`)
    .replace("const CLOUD_CONFIGURED = false;", "const CLOUD_CONFIGURED = true;");
  if (popup === originalPopup) throw new Error("Extension default endpoint marker was not found.");
  fs.writeFileSync(popupPath, popup);
}
const backgroundPath = path.join(output, "background.js");
const originalBackground = fs.readFileSync(backgroundPath, "utf8");
const background = originalBackground
  .replace('const DEFAULT_ENDPOINT = "http://127.0.0.1:4310";', `const DEFAULT_ENDPOINT = ${JSON.stringify(origin)};`)
  .replace('const DEFAULT_CAPTURE_TOKEN = "";', `const DEFAULT_CAPTURE_TOKEN = ${JSON.stringify(preserveStoredToken ? '' : captureToken)};`);
if (background === originalBackground) throw new Error("Extension background endpoint marker was not found.");
fs.writeFileSync(backgroundPath, background);
fs.writeFileSync(path.join(output, 'INSTALL.md'), `# SoloToChina 扩展连接说明\n\nCMS 服务地址：${origin}\n\n${preserveStoredToken
  ? '此安装包不内嵌采集令牌。只有原扩展身份下已保存的设置会保留；新目录加载或重新安装可能成为新的扩展，不会自动继承旧令牌。'
  : '此私有安装包包含采集凭据，请勿公开分享或提交到仓库。'}\n\n更新已有扩展时，将文件覆盖到原加载目录，再在扩展管理中重新加载；不要为了更新另建第二个扩展。\n\n首次使用：\n1. 打开扩展底部“同步与连接设置”。\n2. 核对CMS地址；若采集令牌显示“请输入”，填写现有CMS的CAPTURE_TOKEN。不要把令牌发送到聊天或问题报告。\n3. 点击“保存设置”，再点击“检查已保存的连接”。此检查只查询空身份列表，不创建采集任务。\n4. 验证通过后，回到目标收藏夹点击“同步新增收藏”。\n\n“采集令牌已保存”只表示本地有值，是否有效以连接检查结果为准。\n`, 'utf8');
console.log(`Cloud extension package created at ${output}`);
fs.appendFileSync(path.join(output, 'INSTALL.md'), `\n固定扩展 ID：${extensionId}\n后续更新保留 manifest.key，无论解压目录如何变化，ID 均保持固定。打包器会拒绝缺失或变更的身份。\n旧版未设置固定 ID，首次切换到此版本是一次身份迁移，可能需要重新保存现有采集令牌；此后请保留原扩展并重新加载更新，勿卸载。服务器已允许此固定 ID。\n`);

function normalizeOrigin(value) {
  try {
    const url = new URL(value || "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readCaptureToken(filename) {
  if (!filename) return "";
  try {
    const line = fs.readFileSync(path.resolve(filename), "utf8").split(/\r?\n/).find((item) => item.startsWith("CAPTURE_TOKEN="));
    const value = line?.slice("CAPTURE_TOKEN=".length).trim() || "";
    return /^[A-Za-z0-9_-]{24,}$/.test(value) ? value : "";
  } catch { return ""; }
}
