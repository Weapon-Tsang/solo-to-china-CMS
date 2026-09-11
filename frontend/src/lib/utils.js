import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function label(value) {
  const key = String(value ?? "").toLowerCase();
  const categoryLabels = { source: "来源", knowledge: "知识库", job: "任务", sync: "同步", maintenance: "维护", brief: "文章", wordpress: "WordPress" };
  if (categoryLabels[key]) return categoryLabels[key];
  const chinese = { processing: "处理中", captured: "已采集", queued: "排队中", processed: "提取完成", needs_ai: "等待 AI", exception: "需要处理", running: "执行中", pending: "待处理", succeeded: "成功", failed: "失败", configured: "已配置", ready: "就绪", candidate: "候选", corroborated: "已佐证", conflicted: "存在冲突", active: "启用", inactive: "停用", ready_for_wordpress: "可发送到 WordPress", not_configured: "未配置", warning: "注意", blocker: "阻塞", single_source: "单一来源", research_required: "需补充研究", approved_article: "已批准文章", knowledge_only: "仅入知识库", cluster: "归入专题", research_first: "优先补充研究", ignored: "已忽略", stale: "可能过期", current: "当前", requires_official: "需官方核验", medium: "中", high: "高", low: "低", not_synced: "未同步", draft: "草稿", commercial_ready: "商品已组合", wordpress_draft: "WordPress 草稿", passed: "通过", published: "已发布" };
  chinese.resolved = "已人工确认";
  Object.assign(chinese, {
    producing: "创作中", drafted: "已创建内容", brief_ready: "写作准备完成",
    approved_waiting_for_evidence: "已批准，等待证据", approved_ready: "已批准，待生产",
    not_tested: "尚未验证", qa_queued: "等待质检", qa_failed: "质检未通过", awaiting_review: "等待完成页面与质检",
    review_draft: "质量审核", revise_draft: "修订正文", compose_frontend_page: "页面编排", plan_content: "准备写作",
    review_draft_queued: "质检排队中（未改写）", review_draft_running: "正在质检（未改写）",
    revise_draft_queued: "修订排队中", revise_draft_running: "正在修订",
    compose_frontend_page_queued: "页面编排排队中", compose_frontend_page_running: "正在编排页面",
    plan_content_queued: "写作准备排队中", plan_content_running: "正在准备写作",
    generate_visuals_queued: "图片处理排队中", generate_visuals_running: "正在处理图片",
    verified: "已核验", unverified: "未核验", partial: "部分完成", complete: "完整", completed: "已完成",
    retrying: "重试中", retry_required: "等待定向重试", manual_review: "需要人工检查", extracted: "已提取，等待审计",
    paragraph_group: "段落组", image: "图片", video: "视频", text: "文本", document: "文档",
    entity: "实体", route: "路线", area: "区域", destination: "目的地", country: "国家", category: "类别",
    global: "全局", manual: "人工", full: "完整历史", incremental: "增量", json: "JSON",
    pending_review: "等待审核", ready_for_manual: "等待人工建链", invalid: "无效", skipped: "已跳过",
    needs_sources: "需补充素材", evaluating: "素材检测中", suppressed: "已阻止重复生产",
    city_walk: "City Walk", itinerary: "行程攻略", food: "美食专题", attraction_list: "景点清单",
    accommodation: "住宿专题", practical: "实用专题", custom: "自定义专题",
    food_guide: "美食指南", hotel_area_guide: "住宿区域指南", listicle: "清单专题", practical_guide: "实用指南",
    same_entity: "同一实体", different_entity: "不同实体", create_relation: "建立关系", defer: "暂不判断",
    uncertain: "不确定", excluded: "已排除", composed: "已编排", hotel: "酒店", flight: "航班", train: "火车票",
    attraction: "景点门票", tour_activity: "旅游活动", flight_hotel: "机票 + 酒店", car_rental: "租车",
    airport_transfer: "机场接送", planner: "行程规划", category_link: "分类链接", custom_link: "自定义链接",
  });
  if (chinese[key]) return chinese[key];
  const original = String(value ?? "").trim();
  if (!original) return "未知";
  if (/^[a-z0-9_.:-]+$/iu.test(original)) return "未知状态";
  return original;
}

export function friendlyError(value, context = {}) {
  const text = String(value || "").trim();
  if (text.startsWith("Coverage audit still found material evidence without Claims after one targeted retry.")) {
    return "覆盖审计在一次定向重试后仍发现未形成信息主张的重要证据，需要人工检查。";
  }
  if (!text) return context.status ? `操作没有完成（服务返回 ${context.status}）。请稍后重试。` : "操作没有完成。请稍后重试。";
  if (/incorrect current password|invalid password|authentication failed/iu.test(text)) return "当前密码不正确，请重新输入。";
  if (/too many sign-in|rate.?limit|too many requests|\b429\b/iu.test(text)) return "请求过于频繁，请稍后再试。";
  if (/aborted|aborterror|timed? ?out|timeout/iu.test(text)) return "处理超时，系统已保留现有进度。请稍后重试。";
  if (/no structured output|empty structured|returned no .*output/iu.test(text)) return "模型没有返回可用结果，系统已保留输入，请重新执行。";
  if (/qa_failed|quality .*failed|review .*failed/iu.test(text)) return "质量检查未通过。请打开处理入口查看具体原因。";
  if (/authorized source image.*403/iu.test(text)) return "来源图片未能保存。请重新采集原文，系统会保留已有正文和证据。";
  if (/token|output limit|maximum output|too long/iu.test(text)) return "本次内容超过模型单次处理上限，系统将缩小修订范围后重试。";
  if (/\b403\b|forbidden|permission denied/iu.test(text)) return "当前服务拒绝了这次请求，请检查对应服务的权限或凭据。";
  if (/\b401\b|unauthori[sz]ed/iu.test(text)) return "当前登录或服务授权已失效，请重新验证。";
  if (/not found|\b404\b/iu.test(text)) return "没有找到需要处理的记录，页面数据可能已经更新。";
  if (/network|fetch failed|connection|econn/iu.test(text)) return "网络连接中断，系统已保留现有数据，请稍后重试。";
  if (/invalid input|bad request|\b400\b/iu.test(text)) return "提交的信息不完整或格式不正确，请检查后重试。";
  if (/[\u3400-\u9fff]/u.test(text) && !/[A-Za-z]{12,}/u.test(text)) return text;
  return "操作没有完成。系统已保存错误记录，请稍后重试；若仍失败，请打开处理入口查看中文说明。";
}

export function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function normalizeQualityIssue(issue) {
  const value = typeof issue === "string" ? { reason: issue } : issue && typeof issue === "object" ? issue : {};
  const chineseText = (text, fallback) => {
    const candidate = String(text || "").trim();
    return candidate && /[\u3400-\u9fff]/u.test(candidate) ? candidate : fallback;
  };
  return {
    severity: value.severity === "warning" ? "warning" : "blocker",
    title: chineseText(value.title, "质量检查没有通过"),
    reason: chineseText(value.reason || value.message, "检查结果没有返回可显示的中文原因，系统已保留原始记录。"),
    action: chineseText(value.action, "请重新执行本次质量检查；如果仍然没有原因，请在“需要处理”中打开该文章的处理入口。"),
  };
}

export function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10} 秒`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} 分钟`;
  return `${Math.round(milliseconds / 360_000) / 10} 小时`;
}
