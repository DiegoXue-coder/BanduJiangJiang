const ACTIVE_CAPTION_OPACITY = 1;
const READ_CAPTION_OPACITY = 0.36;
const UPCOMING_CAPTION_OPACITY = 0.62;

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

module.exports = {
  captionOpacityForIndex,
  centeredScrollOffset,
  playbackRecoveryAction,
  preparedSoundMatches,
  resolveNarrationStep,
};
