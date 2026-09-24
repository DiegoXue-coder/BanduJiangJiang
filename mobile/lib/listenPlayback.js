const ACTIVE_CAPTION_OPACITY = 1;
const READ_CAPTION_OPACITY = 0.58;
const UPCOMING_CAPTION_OPACITY = 0.74;
const DEFAULT_CAPTION_PHRASE_MAX_LENGTH = 14;

function captionOpacityForIndex(index, activeIndex) {
  if (index === activeIndex) return ACTIVE_CAPTION_OPACITY;
  return index < activeIndex ? READ_CAPTION_OPACITY : UPCOMING_CAPTION_OPACITY;
}

function centeredScrollOffset({ layout, containerY = 0, viewportHeight = 0, contentHeight = 0 }) {
  if (!layout || viewportHeight <= 0) return null;
  const targetCenter = containerY + layout.y + layout.height / 2;
  const maxY = Math.max(0, contentHeight - viewportHeight);
  return Math.max(0, Math.min(maxY, targetCenter - viewportHeight / 2));
}

function centeredPhraseIndex({ layouts, containerY = 0, scrollY = 0, viewportHeight = 0 }) {
  if (!layouts || viewportHeight <= 0) return null;
  const viewportCenter = scrollY + viewportHeight / 2;
  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  Object.entries(layouts).forEach(([rawIndex, layout]) => {
    if (!layout || !Number.isFinite(layout.y) || !Number.isFinite(layout.height)) return;
    const phraseCenter = containerY + layout.y + layout.height / 2;
    const distance = Math.abs(phraseCenter - viewportCenter);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = Number(rawIndex);
    }
  });
  return bestIndex;
}

function playbackRecoveryAction({ status, phase, isManuallyPaused, voiceInteractionActive = false }) {
  if (voiceInteractionActive) return 'none';
  if (phase !== 'playing') return 'none';
  if (!status || status.isLoaded !== true) return isManuallyPaused ? 'wait-for-user' : 'rebuild';
  if (isManuallyPaused) return 'keep-paused';
  if (status.isPlaying || status.isBuffering) return 'none';
  if (status.didJustFinish) return 'none';
  return 'resume';
}

function preparedSoundMatches(prepared, { chapterIdx, paragraphIdx, voice, rate }) {
  return !!prepared
    && prepared.ci === chapterIdx
    && prepared.pi === paragraphIdx
    && prepared.voice === voice
    && prepared.rate === rate;
}

function resolveNarrationStep({
  chapterIdx,
  paragraphIdx,
  direction,
  chapterCount,
  currentParagraphCount,
  adjacentParagraphCount = 0,
}) {
  if (direction > 0) {
    if (paragraphIdx + 1 < currentParagraphCount) {
      return { chapterIdx, paragraphIdx: paragraphIdx + 1 };
    }
    if (chapterIdx + 1 < chapterCount) return { chapterIdx: chapterIdx + 1, paragraphIdx: 0 };
  } else if (direction < 0) {
    if (paragraphIdx > 0) return { chapterIdx, paragraphIdx: paragraphIdx - 1 };
    if (chapterIdx > 0 && adjacentParagraphCount > 0) {
      return { chapterIdx: chapterIdx - 1, paragraphIdx: adjacentParagraphCount - 1 };
    }
  }
  return null;
}

// 任务卡09/11第二阶段：用户手动滑到某一句、点它跳转朗读——给定"这句在整章
// 文本里的字符偏移"和"当前章节各TTS分块的长度"，算出应该从哪个分块
// （paragraphIdx）、分块内第几个字（charOffset）开始播放。跟resumeSlice/
// shouldResumeWithinParagraph复用同一套"段内恢复"机制：调用方只要把这里
// 算出的{chapterIdx, paragraphIdx, charOffset}原样写进paragraphProgressRef
// 再调playFrom(chapterIdx, paragraphIdx, epoch)，不需要改playFrom本身。
function resolveJumpTarget({ chunkLengths, chapterIdx, charOffset }) {
  const lengths = Array.isArray(chunkLengths) ? chunkLengths : [];
  if (!lengths.length) return null;
  const safeOffset = Math.max(0, Number(charOffset) || 0);
  let cursor = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const len = Math.max(0, Number(lengths[i]) || 0);
    const isLast = i === lengths.length - 1;
    if (safeOffset < cursor + len || isLast) {
      return { chapterIdx, paragraphIdx: i, charOffset: Math.max(0, Math.min(len, safeOffset - cursor)) };
    }
    cursor += len;
  }
  return null; // 不可达：lengths非空时循环一定会在isLast命中返回
}

function captionVisualStateForSentence(sentenceIndex, activeSentenceIndex) {
  if (sentenceIndex === activeSentenceIndex) return 1;
  return sentenceIndex < activeSentenceIndex ? 0 : 2;
}

function splitCaptionPhrases(text, maxLength = DEFAULT_CAPTION_PHRASE_MAX_LENGTH) {
  if (!text) return [];
  const safeMaxLength = Math.max(8, Number(maxLength) || DEFAULT_CAPTION_PHRASE_MAX_LENGTH);
  const ranges = [];
  const naturalBreak = /[，、：；。！？,;:!?\n]/;
  const closingMark = /[”’」』】）》〉]/;
  let start = 0;
  let index = 0;

  const pushRange = (end) => {
    if (end <= start) return;
    ranges.push({ text: text.slice(start, end), start, end });
    start = end;
  };

  while (index < text.length) {
    const length = index - start + 1;
    if (naturalBreak.test(text[index])) {
      let end = index + 1;
      while (end < text.length && closingMark.test(text[end])) end += 1;
      pushRange(end);
      index = end;
      continue;
    }
    if (length >= safeMaxLength) pushRange(index + 1);
    index += 1;
  }
  pushRange(text.length);
  return ranges;
}

function rangeIndexAtOffset(ranges, offset) {
  if (!Array.isArray(ranges) || ranges.length === 0) return 0;
  const safeOffset = Math.max(0, Number(offset) || 0);
  const found = ranges.findIndex((range) => safeOffset < range.end);
  return found === -1 ? ranges.length - 1 : found;
}

function stripCitationMarkersForSpeech(text) {
  return String(text || '')
    .replace(/(?:\s*[\[【]\s*\d+(?:\s*[-–—,，、]\s*\d+)*\s*[\]】])+/g, '')
    .replace(/[ \t]+([，。！？；：,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function expectsExternalSearch(question) {
  const text = String(question || '');
  const bookAnchors = ['这段', '这句', '这里', '这一段', '这一句', '原文', '书中', '书里', '上文', '上面这'];
  if (bookAnchors.some((hint) => text.includes(hint))) return false;
  const directHints = [
    '现在', '最近', '目前', '最新', '近期', '如今', '现状', '今年', '去年', '作者',
    '现实中', '真实存在', '历史上', '新闻', '报道', '官方', '数据是', '规模', '统计',
    '创始人', '创办人', '谁创办', '成立于', '营收', '收入', '利润', '财报', '市值',
    '总部', '首席执行官', 'CEO', '员工数', '市场份额',
  ];
  if (directHints.some((hint) => text.includes(hint))) return true;
  const entities = ['事务所', '公司', '企业', '机构', '品牌', '银行', '基金', '大学', '医院', '组织'];
  const factQuestions = ['是什么', '是谁', '有哪些', '哪几', '多少', '怎么样', '如何', '情况'];
  return entities.some((hint) => text.includes(hint))
    && factQuestions.some((hint) => text.includes(hint));
}

module.exports = {
  captionOpacityForIndex,
  captionVisualStateForSentence,
  centeredScrollOffset,
  centeredPhraseIndex,
  playbackRecoveryAction,
  preparedSoundMatches,
  resolveNarrationStep,
  resolveJumpTarget,
  splitCaptionPhrases,
  rangeIndexAtOffset,
  stripCitationMarkersForSpeech,
  expectsExternalSearch,
};
