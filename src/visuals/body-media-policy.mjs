// Strategy 3.9 introduced original-source body media. Covers are governed by
// their separate, explicitly authorized abstract-illustration workflow.
export function requiresOriginalBodyMedia(version = '3.9') {
  const [major, minor] = String(version || '3.9').split('.').map(Number);
  return !Number.isFinite(major) || major > 3 || (major === 3 && (!Number.isFinite(minor) || minor >= 9));
}
