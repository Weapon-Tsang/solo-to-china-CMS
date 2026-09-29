// Reversible wire-only IDs preserve every claim/span and its original text.
export function compactExperienceReferences(input) {
  const forward = new Map(), reverse = new Map();
  let prefix = '@experience:';
  while (JSON.stringify(input).includes(prefix)) prefix = `@${prefix}`;
  for (const [key, kind] of [['segments','segment'],['claims','claim'],['evidence_spans','span'],['media','asset']])
    for (const [index, item] of (input[key] || []).entries()) {
      if (typeof item.id !== 'string' || forward.has(item.id)) continue;
      const alias = `${prefix}${kind}:${index}`;
      forward.set(item.id, alias); reverse.set(alias, item.id);
    }
  return { input: replace(input, forward), restore: output => replace(output, reverse) };
}

function replace(value, mapping) {
  if (typeof value === 'string') return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => replace(item, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replace(item, mapping)]));
  return value;
}
