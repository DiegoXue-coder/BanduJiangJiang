const DEFAULT_CONTEXT_LIMIT = 1200;

function normalizeParagraphs(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/[\t \u00a0]+/g, ' ').replace(/\n+/g, ' ').trim())
    .filter(Boolean);
}

function truncateAtParagraphBoundary(text, limit = DEFAULT_CONTEXT_LIMIT) {
  const paragraphs = normalizeParagraphs(text);
  if (!paragraphs.length) return '';
  const safeLimit = Math.max(120, Number(limit) || DEFAULT_CONTEXT_LIMIT);
  const joined = paragraphs.join('\n\n');
  if (joined.length <= safeLimit) return joined;
  const selected = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const addition = paragraph.length + (selected.length ? 2 : 0);
    if (selected.length && used + addition > safeLimit) break;
    if (!selected.length && paragraph.length > safeLimit) {
      const floor = Math.floor(safeLimit * 0.72);
      const candidates = '。！？；：.!?;:';
      let end = -1;
      for (let index = safeLimit; index >= floor; index -= 1) {
        if (candidates.includes(paragraph[index - 1])) { end = index; break; }
      }
      selected.push(paragraph.slice(0, end > 0 ? end : safeLimit).trim());
      break;
    }
    selected.push(paragraph);
    used += addition;
  }
  return selected.join('\n\n');
}

function standardBlocksToContext(blocks, limit = DEFAULT_CONTEXT_LIMIT) {
  const paragraphs = [];
  (Array.isArray(blocks) ? blocks : []).forEach((block) => {
    if (!block) return;
    if (block.type === 'table' && Array.isArray(block.rows)) {
      block.rows.forEach((row) => {
        const line = (Array.isArray(row) ? row : []).map((cell) => String(cell || '').trim()).filter(Boolean).join(' | ');
        if (line) paragraphs.push(line);
      });
      return;
    }
    const text = String(block.text || '').trim();
    if (text && block.type !== 'image') paragraphs.push(text);
  });
  return truncateAtParagraphBoundary(paragraphs.join('\n\n'), limit);
}

module.exports = {
  DEFAULT_CONTEXT_LIMIT,
  normalizeParagraphs,
  standardBlocksToContext,
  truncateAtParagraphBoundary,
};
