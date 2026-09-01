import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function label(value) {
  const key = String(value ?? "").toLowerCase();
  const categoryLabels = { source: "来源", knowledge: "知识库", job: "任务", sync: "同步", maintenance: "维护", brief: "内容规划", wordpress: "WordPress" };
  if (categoryLabels[key]) return categoryLabels[key];
  const chinese = { processing: "处理中", captured: "已采集", queued: "排队中", processed: "提取完成", needs_ai: "等待 AI", exception: "需要处理", running: "执行中", pending: "待处理", succeeded: "成功", failed: "失败", configured: "已配置", ready: "就绪", candidate: "候选", corroborated: "已佐证", conflicted: "存在冲突", active: "启用", inactive: "停用", ready_for_wordpress: "可发送到 WordPress", not_configured: "未配置", warning: "注意", blocker: "阻塞", single_source: "单一来源", research_required: "需补充研究", approved_article: "已批准文章", knowledge_only: "仅入知识库", cluster: "归入专题", research_first: "优先补充研究", ignored: "已忽略", stale: "可能过期", current: "当前", requires_official: "需官方核验", medium: "中", high: "高", low: "低", not_synced: "未同步", draft: "草稿", commercial_ready: "商品已组合", wordpress_draft: "WordPress 草稿", passed: "通过", published: "已发布" };
  return chinese[key] || String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10} sec`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} min`;
  return `${Math.round(milliseconds / 360_000) / 10} hr`;
}
