export function visualQaMentionsSpellingError(value = {}) {
  const commentary = [value?.notes, value?.language?.reason, value?.semantic?.reason]
    .filter(Boolean).join(' ');
  const spellingIssue = /\b(?:typos?|misspell(?:ed|ing|ings)?|incorrect (?:pinyin|romanization|transliteration))\b/i;
  const explicitlyAbsent = /\b(?:no|without|free of)\s+(?:(?:visible|detected|obvious|noted)\s+)?(?:typos?|misspellings?)\b/i;
  return spellingIssue.test(commentary) && !explicitlyAbsent.test(commentary);
}
