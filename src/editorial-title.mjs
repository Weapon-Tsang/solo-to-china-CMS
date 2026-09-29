// Match only the known boilerplate, never strip an editorially specific subtitle.
const GENERIC_GUIDE = /\s*[:：]\s*(?:a\s+)?(?:complete\s+|practical\s+)?(?:(?:visitor\s+)?guide\s+for\s+(?:independent(?:\s+and\s+solo)?|solo(?:\s+and\s+independent)?)\s+travel(?:l)?ers|independent\s+(?:(?:traveler|traveller|visitor)\s+)?guide)(?:\s*\(\d{4}\))?\s*$/iu;

export function boilerplateTitleSubject(title) {
  const value = String(title || '').trim();
  return GENERIC_GUIDE.test(value) ? value.replace(GENERIC_GUIDE, '').trim() : null;
}

export function opportunityTitleSubject(opportunity) {
  const entities = opportunity.coverage?.proposal?.targetEntities;
  if (Array.isArray(entities) && entities.length === 1 && typeof entities[0] === 'string' && entities[0].trim()) return entities[0].trim();
  return boilerplateTitleSubject(opportunity.title) || String(opportunity.title || '').trim();
}

const FACETS = [
  [/^(?:reservation|reservation_required|booking|booking_requirement|booking_requirements|booking_method)$/u, 'Booking', '预约'],
  [/^(?:ticket|ticket_price|admission|admission_fee|entry_fee|price|cost)$/u, 'Costs', '费用'],
  [/^(?:opening_hours|hours|schedule|operating_hours)$/u, 'Opening Hours', '开放时间'],
  [/^(?:transport|transport_access|access|getting_there|metro|station|transport_route)$/u, 'Getting There', '交通'],
  [/^(?:route|itinerary|route_sequence)$/u, 'Route', '路线'],
  [/^(?:payment|payment_method|payment_methods)$/u, 'Payment', '支付'],
  [/^(?:recommended_dish|signature_dish|dish|food_recommendation)$/u, 'What to Order', '点餐'],
  [/^(?:best_time|best_time_to_visit|visit_timing)$/u, 'When to Visit', '游览时机'],
  [/^(?:duration|visit_duration|recommended_duration)$/u, 'Time Needed', '游览用时'],
  [/^(?:accessibility|wheelchair_access)$/u, 'Accessibility', '无障碍通行'],
];

export function evidenceTitle(subject, facts = []) {
  const topic = boilerplateTitleSubject(subject) || String(subject || '').trim();
  const chinese = /\p{Script=Han}/u.test(topic);
  const predicates = facts.filter(fact => fact && fact.consensus_status !== 'conflicted'
    && fact.visibility_status !== 'hidden' && ['current','unknown'].includes(fact.validity_state || 'unknown')
    && (fact.preferred_value === undefined || Boolean(String(fact.preferred_value || '').trim())))
    .map(fact => String(fact.canonical_predicate || fact.predicate || '').toLowerCase().replace(/[\s-]+/gu, '_'));
  const facets = FACETS.filter(([pattern]) => predicates.some(predicate => pattern.test(predicate)))
    .slice(0, 3).map(([, english, translated]) => chinese ? translated : english);
  // A topic label is honest when the evidence does not support a specific promise.
  return facets.length ? `${topic}${chinese ? '：' : ': '}${facets.join(chinese ? '、' : ', ')}` : topic;
}
