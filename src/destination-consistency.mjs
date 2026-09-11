const KNOWN_DESTINATIONS = [
  ["beijing", /(?:\bbeijing\b|\u5317\u4eac)/iu],
  ["shanghai", /(?:\bshanghai\b|\u4e0a\u6d77)/iu],
  ["xian", /(?:\bxi[\u2019' -]?an\b|\u897f\u5b89)/iu],
  ["chengdu", /(?:\bchengdu\b|\u6210\u90fd)/iu],
  ["chongqing", /(?:\bchongqing\b|\u91cd\u5e86)/iu],
  ["hangzhou", /(?:\bhangzhou\b|\u676d\u5dde)/iu],
  ["suzhou", /(?:\bsuzhou\b|\u82cf\u5dde)/iu],
  ["guilin", /(?:\bguilin\b|\u6842\u6797)/iu],
  ["guangzhou", /(?:\bguangzhou\b|\u5e7f\u5dde)/iu],
  ["shenzhen", /(?:\bshenzhen\b|\u6df1\u5733)/iu],
  ["yunnan", /(?:\byunnan\b|\u4e91\u5357)/iu],
  ["zhangjiajie", /(?:\bzhangjiajie\b|\u5f20\u5bb6\u754c)/iu],
];

export function validatePlanningDestination(contentPackage = {}) {
  const candidate = contentPackage.candidate || {};
  const destinationSlug = String(candidate.destination_slug || "").toLowerCase();
  const assignedDestination = KNOWN_DESTINATIONS.find(([slug]) => destinationSlug === slug
    || destinationSlug.startsWith(`${slug}-`) || destinationSlug.endsWith(`-${slug}`))?.[0] || destinationSlug;
  const evidenceText = [candidate.proposed_title, contentPackage.source_reference?.title]
    .filter(Boolean).join(" ");
  const explicitDestinations = KNOWN_DESTINATIONS.filter(([, pattern]) => pattern.test(evidenceText)).map(([slug]) => slug);
  if (explicitDestinations.length && assignedDestination && !explicitDestinations.includes(assignedDestination)) {
    return {
      valid: false,
      code: "DESTINATION_TOPIC_MISMATCH",
      assignedDestination,
      explicitDestinations,
      message: `Planning is blocked because the topic explicitly names ${explicitDestinations.join(", ")} but is assigned to ${destinationSlug || "an unknown destination"}. Correct the destination and rebuild its scoped evidence before retrying.`,
    };
  }
  return { valid: true, code: null, assignedDestination, explicitDestinations };
}
