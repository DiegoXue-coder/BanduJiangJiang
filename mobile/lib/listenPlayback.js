const ACTIVE_CAPTION_OPACITY = 1;
const READ_CAPTION_OPACITY = 0.36;
const UPCOMING_CAPTION_OPACITY = 0.62;
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

function playbackRecoveryAction({ status, phase, isManuallyPaused }) {
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

module.exports = {
  captionOpacityForIndex,
  centeredScrollOffset,
  playbackRecoveryAction,
  preparedSoundMatches,
  resolveNarrationStep,
  resolveJumpTarget,
  splitCaptionPhrases,
  rangeIndexAtOffset,
};
