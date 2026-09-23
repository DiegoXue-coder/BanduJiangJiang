const STANDARD_PROGRESS_PREFIX = 'standard-progress:';
const NARRATION_SENTENCE_END = /([。！？；\n])/;
const NARRATION_MIN_CHUNK_LEN = 60;
const LIST_MARKER_RE = /^([一二三四五六七八九十百]{1,3}[、，]|[（(][一二三四五六七八九十0-9]{1,3}[）)]|[0-9]{1,3}、)/;

function normalizeReaderText(value) {
  return String(value || '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[“”‘’]/g, '"')
    .replace(/[，]/g, ',')
    .replace(/[。]/g, '.')
    .trim();
}

function parseReaderLocation(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith(STANDARD_PROGRESS_PREFIX)) {
    const [chapterId, rawPage] = text.slice(STANDARD_PROGRESS_PREFIX.length).split(':');
    const pageIndex = Number.parseInt(rawPage, 10);
    return chapterId && Number.isFinite(pageIndex)
      ? { kind: 'progress', chapterId, pageIndex: Math.max(0, pageIndex) }
      : null;
  }
  const firstRangePart = text.split('..', 1)[0];
  const match = /^(standard|listen):([^:]+):(\d+)$/.exec(firstRangePart);
  if (match) {
    return {
      kind: match[1],
      chapterId: match[2],
      paragraphIndex: Math.max(0, Number.parseInt(match[3], 10)),
    };
  }
  if (text.startsWith('epubcfi(')) return { kind: 'epub', cfi: text };
  return { kind: 'unknown', raw: text };
}

function mergeParagraphsForReaderLocation(paragraphs) {
  let buffer = (paragraphs || []).map((p) => String(p || '')).join('');
  const merged = [];
  let pending = '';
  for (;;) {
    if (pending && LIST_MARKER_RE.test(buffer)) {
      merged.push(pending);
      pending = '';
    }
    const idx = buffer.search(NARRATION_SENTENCE_END);
    if (idx === -1) break;
    pending += buffer.slice(0, idx + 1);
    buffer = buffer.slice(idx + 1);
    if (pending.length >= NARRATION_MIN_CHUNK_LEN) {
      merged.push(pending);
      pending = '';
    }
  }
  pending += buffer;
  if (pending) merged.push(pending);
  return merged;
}

function searchableBlocks(payload) {
  const blocks = Array.isArray(payload?.blocks) && payload.blocks.length
    ? payload.blocks
    : (payload?.paragraphs || []).map((text, index) => ({ type: 'text', text, sourceIndex: index }));
  return blocks
    .map((block, index) => ({
      text: String(block?.text || ''),
      paragraphIndex: Number.isFinite(block?.sourceIndex) ? block.sourceIndex : index,
    }))
    .filter((block) => normalizeReaderText(block.text));
}

function findTextMatchesInPayload(payload, targetText) {
  const needle = normalizeReaderText(targetText);
  if (!needle) return [];
  const blocks = searchableBlocks(payload);
  let aggregate = '';
  const spans = [];
  blocks.forEach((block) => {
    const text = normalizeReaderText(block.text);
    const start = aggregate.length;
    aggregate += text;
    spans.push({ start, end: aggregate.length, paragraphIndex: block.paragraphIndex });
  });
  const matches = [];
  let from = 0;
  while (from <= aggregate.length - needle.length) {
    const at = aggregate.indexOf(needle, from);
    if (at < 0) break;
    const span = spans.find((item) => at < item.end && at + needle.length > item.start);
    if (span) matches.push({ paragraphIndex: span.paragraphIndex, offset: at });
    from = at + Math.max(1, needle.length);
  }
  return matches;
}

function findPageIndexForTarget(pages, { paragraphIndex, text } = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const needle = normalizeReaderText(text);
  if (needle) {
    const textMatches = [];
    list.forEach((page, pageIndex) => {
      const pageText = normalizeReaderText((page || []).map((block) => block?.text || '').join(''));
      if (pageText.includes(needle)) textMatches.push(pageIndex);
    });
    if (textMatches.length === 1) return { pageIndex: textMatches[0], matchedBy: 'text' };
  }
  if (Number.isFinite(paragraphIndex)) {
    const pageIndex = list.findIndex((page) => (page || []).some(
      (block) => Number(block?.paragraphIndex) === Number(paragraphIndex),
    ));
    if (pageIndex >= 0) return { pageIndex, matchedBy: 'paragraph' };
  }
  return null;
}

module.exports = {
  findPageIndexForTarget,
  findTextMatchesInPayload,
  mergeParagraphsForReaderLocation,
  normalizeReaderText,
  parseReaderLocation,
};
