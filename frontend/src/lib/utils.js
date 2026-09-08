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
  chinese.resolved = "已人工确认";
  Object.assign(chinese, {
    verified: "已核验", unverified: "未核验", partial: "部分完成", complete: "完整", completed: "已完成",
    retrying: "重试中", retry_required: "等待定向重试", manual_review: "需要人工检查", extracted: "已提取，等待审计",
    paragraph_group: "段落组", image: "图片", video: "视频", text: "文本", document: "文档",
    entity: "实体", route: "路线", area: "区域", destination: "目的地", country: "国家", category: "类别",
    global: "全局", manual: "人工", full: "完整历史", incremental: "增量", json: "JSON",
    pending_review: "等待审核", ready_for_manual: "等待人工建链", invalid: "无效", skipped: "已跳过",
    same_entity: "同一实体", different_entity: "不同实体", create_relation: "建立关系", defer: "暂不判断",
    uncertain: "不确定", excluded: "已排除", composed: "已编排", hotel: "酒店", flight: "航班", train: "火车票",
    attraction: "景点门票", tour_activity: "旅游活动", flight_hotel: "机票 + 酒店", car_rental: "租车",
    airport_transfer: "机场接送", planner: "行程规划", category_link: "分类链接", custom_link: "自定义链接",
  });
  return chinese[key] || String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function friendlyError(value) {
  const text = String(value || "");
  if (text.startsWith("Coverage audit still found material evidence without Claims after one targeted retry.")) {
    return "覆盖审计在一次定向重试后仍发现未形成信息主张的重要证据，需要人工检查。";
  }
  return text;
}

export function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10} 秒`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} 分钟`;
  return `${Math.round(milliseconds / 360_000) / 10} 小时`;
}
