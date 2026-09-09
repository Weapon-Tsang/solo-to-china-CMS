import { evaluateCoverage } from "./research-strategy.mjs";
import { slugify } from "./utils.mjs";

export const EDITORIAL_ASSIGNMENT_TYPES = Object.freeze({
  city_walk: {
    label: "City Walk / 城市漫步",
    contentType: "itinerary",
    minimumFacts: 8,
    minimumSourceFamilies: 2,
    minimumEntities: 3,
    minimumRouteFacts: 2,
    topicPattern: /city\s*walk|walking|walkable|route|itinerary|neighbou?rhood|street|alley|district|metro|station|城市漫步|城市散步|步行|徒步|路线|线路|街|巷|片区|街区|景点|地铁|车站|打卡|机位/iu,
    routePattern: /route|order|sequence|walk|walking|distance|duration|minutes?|between|connect|metro|station|路线|线路|顺序|步行|徒步|距离|耗时|分钟|之间|连接|地铁|车站/iu,
  },
  itinerary: {
    label: "行程 / 多日攻略",
    contentType: "itinerary",
    minimumFacts: 8,
    minimumSourceFamilies: 2,
    minimumEntities: 3,
    minimumRouteFacts: 2,
    topicPattern: /itinerary|route|day|transport|duration|timing|行程|路线|线路|一日|两日|三日|天|交通|耗时|时间/iu,
    routePattern: /route|order|sequence|transport|duration|timing|between|路线|线路|顺序|交通|耗时|时间|之间/iu,
  },
  food: {
    label: "美食专题",
    contentType: "food_guide",
    minimumFacts: 7,
    minimumSourceFamilies: 2,
    minimumEntities: 3,
    minimumRouteFacts: 0,
    topicPattern: /food|eat|restaurant|dish|snack|menu|taste|dining|cuisine|美食|小吃|餐厅|菜|吃|味道|点餐|菜单/iu,
  },
  attraction_list: {
    label: "景点 / 机位清单",
    contentType: "listicle",
    minimumFacts: 7,
    minimumSourceFamilies: 2,
    minimumEntities: 5,
    minimumRouteFacts: 0,
    topicPattern: /attraction|viewpoint|photo|landmark|visit|spot|景点|机位|拍照|地标|必去|打卡|地点/iu,
  },
  accommodation: {
    label: "住宿专题",
    contentType: "hotel_area_guide",
    minimumFacts: 6,
    minimumSourceFamilies: 2,
    minimumEntities: 2,
    minimumRouteFacts: 0,
    topicPattern: /hotel|stay|accommodation|hostel|area|district|住宿|酒店|民宿|青旅|住哪|区域|片区/iu,
  },
  practical: {
    label: "实用专题",
    contentType: "practical_guide",
    minimumFacts: 5,
    minimumSourceFamilies: 2,
    minimumEntities: 2,
    minimumRouteFacts: 0,
    topicPattern: /transport|ticket|booking|payment|safety|budget|how|交通|票|预约|支付|安全|预算|怎么|攻略|指南/iu,
  },
  custom: {
    label: "自定义专题",
    contentType: "practical_guide",
    minimumFacts: 5,
    minimumSourceFamilies: 2,
    minimumEntities: 2,
    minimumRouteFacts: 0,
    topicPattern: null,
  },
});

const REQUIREMENT_LABELS = Object.freeze({
  route: "路线与地点衔接",
  duration: "游览或步行耗时",
  transport: "到达方式与公共交通",
  timing: "适合时段与时间安排",
  booking: "预约规则",
  cost: "票价或预算",
  food: "沿途餐饮",
  alternatives: "替代路线或备选方案",
  what_to_eat: "推荐吃什么",
  where_to_eat: "去哪里吃",
  selection_basis: "清单筛选标准",
  items: "可写入清单的具体项目",
  area: "住宿区域",
  traveler_fit: "适合哪类旅行者",
  core_answer: "专题的核心答案",
  steps: "可执行步骤",
  requirements: "前置条件",
});

export function normalizeEditorialAssignmentInput(value = {}) {
  const destinationSlug = slugify(value.destinationSlug || value.destination_slug || "");
  const title = cleanText(value.title, 180);
  if (!destinationSlug) throw badRequest("请选择一个目的地。");
  if (title.length < 2) throw badRequest("请输入至少 2 个字的专题标题。");
  const suppliedType = String(value.assignmentType || value.assignment_type || "").trim().toLowerCase();
  const assignmentType = EDITORIAL_ASSIGNMENT_TYPES[suppliedType] ? suppliedType : inferAssignmentType(title);
  const desiredVisual = ["none", "illustration", "route_sketch"].includes(value.desiredVisual)
    ? value.desiredVisual
    : assignmentType === "city_walk" ? "route_sketch" : "illustration";
  return {
    destinationSlug,
    title,
    assignmentType,
    contentType: EDITORIAL_ASSIGNMENT_TYPES[assignmentType].contentType,
    brief: cleanText(value.brief || value.direction || "", 2_000),
    targetEntities: cleanStrings(value.targetEntities || value.target_entities, 20, 120),
    desiredVisual,
  };
}

export function selectFactsForAssignment(assignment, facts = []) {
  const profile = EDITORIAL_ASSIGNMENT_TYPES[assignment.assignmentType] || EDITORIAL_ASSIGNMENT_TYPES.custom;
  const terms = topicTokens(`${assignment.title || ""} ${assignment.brief || ""}`);
  const entityTerms = topicTokens((assignment.targetEntities || []).join(" "));
  const destinationTerms = topicTokens(`${assignment.destinationSlug || ""} ${assignment.destinationName || ""}`);
  for (const term of destinationTerms) terms.delete(term);
  // A dated travel observation is still usable evidence when the article states
  // its evidence date and uncertainty. Only unresolved strict contradictions are
  // excluded from an assignment package.
  const eligible = facts.filter((fact) => fact.consensus_status !== "conflicted");
  return eligible.map((fact) => {
    const text = factText(fact);
    const tokens = topicTokens(text);
    const entityMatch = [...entityTerms].some((term) => tokens.has(term));
    const topicMatch = [...terms].some((term) => tokens.has(term));
    const profileMatch = profile.topicPattern?.test(text) || relevantEntityType(assignment.assignmentType, fact);
    const routeMatch = Boolean(profile.routePattern?.test(text));
    const include = entityTerms.size
      ? entityMatch || routeMatch
      : profile.topicPattern ? profileMatch || topicMatch : topicMatch;
    const score = (entityMatch ? 30 : 0) + (topicMatch ? 16 : 0) + (profileMatch ? 10 : 0)
      + (routeMatch ? 8 : 0) + Math.min(8, Number(fact.support_count || 0) * 2);
    return { fact, include, score };
  }).filter((item) => item.include).sort((left, right) => right.score - left.score)
    .slice(0, 80).map((item) => item.fact);
}

export function evaluateEditorialAssignment({ assignment, destinationName, facts, sourceFamilyCount = 0 }) {
  const profile = EDITORIAL_ASSIGNMENT_TYPES[assignment.assignmentType] || EDITORIAL_ASSIGNMENT_TYPES.custom;
  const selectedFacts = selectFactsForAssignment({ ...assignment, destinationName }, facts);
  const sourceIds = [...new Set(selectedFacts.flatMap((fact) => (fact.evidence || []).map((item) => item.source_id)).filter(Boolean))];
  const entityNames = [...new Set(selectedFacts.map((fact) => fact.canonical_subject || fact.subject)
    .filter((name) => name && !/^unknown$/i.test(name)))];
  const routeFactCount = profile.routePattern
    ? selectedFacts.filter((fact) => profile.routePattern.test(factText(fact))).length
    : 0;
  const effectiveFamilyCount = Math.max(0, Number(sourceFamilyCount || 0));
  const matrix = evaluateCoverage({
    topicKey: `manual:${assignment.id || slugify(assignment.title)}`,
    contentType: assignment.contentType || profile.contentType,
    facts: selectedFacts,
    sourceFamilyCount: effectiveFamilyCount,
    publicationMode: "topic_feature",
  });
  const gaps = [];
  if (selectedFacts.length < profile.minimumFacts) gaps.push(gap("fact_count", "与专题直接相关的可追溯事实", profile.minimumFacts, selectedFacts.length));
  if (effectiveFamilyCount < profile.minimumSourceFamilies) gaps.push(gap("source_family_count", "相互独立的来源/作者", profile.minimumSourceFamilies, effectiveFamilyCount));
  if (entityNames.length < profile.minimumEntities) gaps.push(gap("entity_count", "可写入专题的具体地点或项目", profile.minimumEntities, entityNames.length));
  if (routeFactCount < profile.minimumRouteFacts) gaps.push(gap("route_count", "地点之间的顺序、步行距离或耗时", profile.minimumRouteFacts, routeFactCount));
  for (const key of matrix.readiness.missingRequirements || []) {
    if (!matrix.requirements.some((item) => item.key === key && item.priority === "required")) continue;
    gaps.push(gap(`coverage:${key}`, REQUIREMENT_LABELS[key] || key, 1, 0));
  }
  const uniqueGaps = [...new Map(gaps.map((item) => [item.key, item])).values()];
  const thresholds = [
    ratio(selectedFacts.length, profile.minimumFacts),
    ratio(effectiveFamilyCount, profile.minimumSourceFamilies),
    ratio(entityNames.length, profile.minimumEntities),
    profile.minimumRouteFacts ? ratio(routeFactCount, profile.minimumRouteFacts) : 1,
  ];
  const score = Math.round(Math.min(100, matrix.readiness.score * 0.6 + (thresholds.reduce((sum, item) => sum + item, 0) / thresholds.length) * 40));
  const ready = uniqueGaps.length === 0 && matrix.readiness.editoriallySufficient;
  const acquisitionRequests = uniqueGaps.map((item, index) => acquisitionRequest({
    gap: item,
    destinationName,
    targetEntities: assignment.targetEntities || [],
    discoveredEntities: entityNames,
    index,
  }));
  return {
    ready,
    score,
    summary: ready
      ? `素材体检通过：已筛出 ${selectedFacts.length} 条直接相关事实、${effectiveFamilyCount} 个独立来源族和 ${entityNames.length} 个具体地点/项目，可按命题边界进入创作队列。`
      : `素材暂不达标：当前只有 ${selectedFacts.length} 条直接相关事实、${effectiveFamilyCount} 个独立来源族和 ${entityNames.length} 个具体地点/项目。补齐下列缺口后再检测即可。`,
    evidence: {
      factCount: selectedFacts.length,
      usableFactCount: matrix.readiness.usableFactCount,
      sourceFamilyCount: effectiveFamilyCount,
      sourceCount: sourceIds.length,
      entityCount: entityNames.length,
      routeFactCount,
      selectedEntities: entityNames.slice(0, 20),
      selectedFactPreview: selectedFacts.slice(0, 12).map((fact) => ({
        key: fact.normalized_key,
        subject: fact.canonical_subject || fact.subject,
        predicate: fact.predicate,
        value: fact.preferred_value,
      })),
    },
    gaps: uniqueGaps,
    acquisitionRequests,
    selectedFactKeys: selectedFacts.map((fact) => fact.normalized_key),
    selectedSourceIds: sourceIds,
    coverage: matrix,
    visualBrief: buildVisualBrief(assignment, destinationName, entityNames, ready),
  };
}

export function inferAssignmentType(value) {
  const text = String(value || "");
  if (EDITORIAL_ASSIGNMENT_TYPES.city_walk.topicPattern.test(text)) return "city_walk";
  if (EDITORIAL_ASSIGNMENT_TYPES.food.topicPattern.test(text)) return "food";
  if (EDITORIAL_ASSIGNMENT_TYPES.accommodation.topicPattern.test(text)) return "accommodation";
  if (EDITORIAL_ASSIGNMENT_TYPES.attraction_list.topicPattern.test(text)) return "attraction_list";
  if (EDITORIAL_ASSIGNMENT_TYPES.itinerary.topicPattern.test(text)) return "itinerary";
  if (EDITORIAL_ASSIGNMENT_TYPES.practical.topicPattern.test(text)) return "practical";
  return "custom";
}

function buildVisualBrief(assignment, destinationName, entities, ready) {
  if (assignment.desiredVisual === "none") return null;
  if (assignment.desiredVisual === "route_sketch") {
    return {
      requested: true,
      type: "route_sketch",
      generationMode: "original_illustration",
      status: ready ? "ready_for_content_planning" : "waiting_for_evidence",
      subject: `${destinationName} · ${(entities.length ? entities.slice(0, 6) : assignment.targetEntities || []).join(" → ") || assignment.title}`,
      instruction: "生成原创的手绘路线概念插画，用节点和动线表达游览顺序；不绘制精确道路，不添加可读文字、商标或虚构地理细节，并明确它不是导航地图。",
    };
  }
  return {
    requested: true,
    type: "editorial_illustration",
    generationMode: "original_illustration",
    status: ready ? "ready_for_content_planning" : "waiting_for_evidence",
    subject: `${destinationName} · ${assignment.title}`,
    instruction: "生成原创编辑插画，不伪造真实场所照片，不添加可读文字、商标或水印。",
  };
}

function acquisitionRequest({ gap: item, destinationName, targetEntities, discoveredEntities, index }) {
  const candidates = targetEntities.length ? targetEntities : discoveredEntities;
  const entity = item.key === "route_count" && candidates.length >= 2
    ? candidates.slice(0, 3).join(" → ")
    : candidates[index % Math.max(1, candidates.length)] || "请先指定 1–3 个 Attraction";
  const sourceType = item.key === "source_family_count"
    ? "另一个独立作者的完整笔记，或当地文旅/景点官方页面"
    : item.key.startsWith("coverage:booking") || item.key.startsWith("coverage:cost") || item.key.startsWith("coverage:timing")
      ? "景点、交通运营方或当地文旅的官方页面"
      : "带原文、图片说明和可定位地点名称的完整游记/攻略";
  return {
    destination: destinationName,
    attraction: entity,
    evidenceType: item.label,
    suggestedSourceType: sourceType,
    message: `请补充 ${destinationName} · ${entity} 的“${item.label}”资料（当前 ${item.current}/${item.required}）；优先采集${sourceType}。`,
  };
}

function relevantEntityType(type, fact) {
  const entityType = String(fact.entity_type || "").toLowerCase();
  if (["city_walk", "itinerary", "attraction_list"].includes(type)) return ["attraction", "landmark", "area", "neighborhood", "transport_hub"].includes(entityType);
  if (type === "food") return ["restaurant", "food", "dish", "market"].includes(entityType);
  if (type === "accommodation") return ["hotel", "area", "neighborhood", "transport_hub"].includes(entityType);
  return false;
}

function factText(fact) {
  return `${fact.normalized_key || ""} ${fact.subject || ""} ${fact.canonical_subject || ""} ${fact.predicate || ""} ${fact.preferred_value || ""}`;
}

function topicTokens(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const words = normalized.split(/\s+/u).filter((item) => item.length > 1);
  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) || [];
  const ngrams = hanRuns.flatMap((run) => {
    const values = [];
    for (const size of [2, 3]) for (let index = 0; index <= run.length - size; index += 1) values.push(run.slice(index, index + size));
    return values;
  });
  return new Set([...words, ...ngrams]);
}

function cleanStrings(value, maxItems, maxLength) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,，\n]/u);
  return [...new Set(values.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function cleanText(value, maxLength) { return String(value || "").trim().replace(/\s+/gu, " ").slice(0, maxLength); }
function ratio(current, required) { return required ? Math.min(1, current / required) : 1; }
function gap(key, label, required, current) { return { key, label, required, current, missing: Math.max(0, required - current) }; }
function badRequest(message) { const error = new Error(message); error.statusCode = 400; return error; }
