const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const DEFAULT_RATE = '+0%';
const RATE_RE = /^[+-](?:\d|[1-9]\d|100)%$/;

function normalizeListenSettings(progress, validVoices = []) {
  const voices = new Set(validVoices);
  const voice = voices.has(progress?.voice) ? progress.voice : DEFAULT_VOICE;
  const rate = RATE_RE.test(String(progress?.rate || '')) ? progress.rate : DEFAULT_RATE;
  return { voice, rate };
}

function resolveListenChapter({ progress, chapters, chapterKind, initialChapterTitle }) {
  const list = Array.isArray(chapters) ? chapters : [];
  const kindMatches = progress?.chapter_kind === chapterKind;
  if (kindMatches && progress?.chapter_id != null) {
    const byId = list.findIndex((chapter) => String(chapter.id) === String(progress.chapter_id));
    if (byId >= 0) return { chapterIdx: byId, useSavedPosition: true, source: 'saved-id' };
  }
  if (kindMatches && String(progress?.chapter_title || '').trim()) {
    const title = String(progress.chapter_title).trim();
    const byTitle = list.findIndex((chapter) => String(chapter.title || '').trim() === title);
    if (byTitle >= 0) return { chapterIdx: byTitle, useSavedPosition: true, source: 'saved-title' };
  }
  const readerTitle = String(initialChapterTitle || '').trim();
  if (readerTitle) {
    const fromReader = list.findIndex((chapter) => String(chapter.title || '').trim() === readerTitle);
    if (fromReader >= 0) return { chapterIdx: fromReader, useSavedPosition: false, source: 'reader' };
  }
  return { chapterIdx: 0, useSavedPosition: false, source: 'book-start' };
}

function resolveListenParagraph(progress, paragraphs, useSavedPosition, startFraction = 0) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  if (!list.length) return { paragraphIdx: 0, charOffset: 0, source: 'empty' };
  if (useSavedPosition) {
    const paragraphIdx = Number(progress?.paragraph_index);
    const charOffset = Number(progress?.char_offset);
    if (Number.isInteger(paragraphIdx) && paragraphIdx >= 0 && paragraphIdx < list.length) {
      const textLength = String(list[paragraphIdx] || '').length;
      if (Number.isInteger(charOffset) && charOffset >= 0 && charOffset <= textLength) {
        return { paragraphIdx, charOffset, source: 'saved' };
      }
    }
    return { paragraphIdx: 0, charOffset: 0, source: 'saved-invalid' };
  }
  const fraction = Number(startFraction);
  if (Number.isFinite(fraction) && fraction > 0) {
    return {
      paragraphIdx: Math.max(0, Math.min(list.length - 1, Math.floor(fraction * list.length))),
      charOffset: 0,
      source: 'reader-fraction',
    };
  }
  return { paragraphIdx: 0, charOffset: 0, source: 'chapter-start' };
}

function historyRowsToMessages(rows, maxTurns = 4) {
  const recent = (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.question || '').trim() || String(row?.answer || '').trim())
    .slice(0, Math.max(0, maxTurns))
    .reverse();
  const messages = [];
  recent.forEach((row) => {
    const question = String(row.question || '').trim();
    const answer = String(row.answer || '').trim();
    if (question) messages.push({ role: 'user', content: question, historical: true });
    if (answer) messages.push({ role: 'assistant', content: answer, historical: true });
  });
  return messages;
}

function appendPromptTurn(messages, question, answer, maxMessages = 8) {
  const next = [...(Array.isArray(messages) ? messages : [])];
  if (String(question || '').trim()) next.push({ role: 'user', content: String(question).trim() });
  if (String(answer || '').trim()) next.push({ role: 'assistant', content: String(answer).trim() });
  return next.slice(-Math.max(2, maxMessages)).map(({ role, content }) => ({ role, content }));
}

module.exports = {
  appendPromptTurn,
  historyRowsToMessages,
  normalizeListenSettings,
  resolveListenChapter,
  resolveListenParagraph,
};
