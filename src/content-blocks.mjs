export function markdownToContentBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let list = [];
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: "list", items: list });
    list = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flushList(); continue; }
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) { list.push(bullet[1]); continue; }
    flushList();
    blocks.push({ type: "paragraph", text: line });
  }
  flushList();
  return blocks;
}

export function contentBlockSummary(blocks) {
  const output = { paragraphs: 0, headings: 0, lists: 0, faq: false };
  for (const block of blocks || []) {
    if (block.type === "paragraph") output.paragraphs += 1;
    if (block.type === "heading") {
      output.headings += 1;
      if (/frequently asked questions/i.test(block.text || "")) output.faq = true;
    }
    if (block.type === "list") output.lists += 1;
  }
  return output;
}
