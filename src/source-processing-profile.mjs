// Observable intake properties select a route; this is not a semantic-quality
// score. Conservative routing stays opt-in until the fixed quality trial passes.
export function sourceProcessingProfile(source = {}) {
  const text = String(source.raw_text || source.rawText || '');
  const media = source.assets || [];
  const reasons = [];
  if (text.length > 8000) reasons.push('long_text');
  if (media.length > 8) reasons.push('dense_media');
  if (media.some(asset => asset.kind === 'video')) reasons.push('video');
  if (source.files?.length || /^#{1,6}\s/gm.test(text)) reasons.push('structured_document');
  const fragment = text.length >= 20 && text.length <= 240 && media.length === 0 && reasons.length === 0;
  return { version: 'source-profile-1', route: reasons.length ? 'segmented' : fragment ? 'fragment' : 'complete_source',
    reasons: reasons.length ? reasons : [fragment ? 'short_text_without_media' : 'bounded_source'],
    textChars: text.length, mediaCount: media.length,
    coveragePolicy: 'existing_exhaustive_audit', experiencePolicy: 'retain_grounded_experience' };
}
