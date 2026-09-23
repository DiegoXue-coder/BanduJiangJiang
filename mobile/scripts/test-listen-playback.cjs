const assert = require('node:assert/strict');
const {
  captionOpacityForIndex,
  centeredScrollOffset,
  playbackRecoveryAction,
  preparedSoundMatches,
  resolveNarrationStep,
} = require('../lib/listenPlayback');

assert.equal(captionOpacityForIndex(3, 3), 1, '当前句必须首帧直接亮起');
assert.equal(captionOpacityForIndex(2, 3), 0.36);
assert.equal(captionOpacityForIndex(4, 3), 0.62);

assert.equal(centeredScrollOffset({
  layout: { y: 300, height: 40 }, containerY: 200, viewportHeight: 400, contentHeight: 1200,
}), 320);
assert.equal(centeredScrollOffset({
  layout: { y: 0, height: 40 }, containerY: 180, viewportHeight: 400, contentHeight: 1200,
}), 0, '首句借助顶部留白可以居中');
assert.equal(centeredScrollOffset({
  layout: { y: 800, height: 40 }, containerY: 200, viewportHeight: 400, contentHeight: 1200,
}), 800, '末句被限制在最大滚动位置');
assert.equal(centeredScrollOffset({ layout: null, viewportHeight: 400, contentHeight: 1200 }), null);

assert.equal(playbackRecoveryAction({ status: null, phase: 'playing', isManuallyPaused: false }), 'rebuild');
assert.equal(playbackRecoveryAction({ status: { isLoaded: false }, phase: 'playing', isManuallyPaused: false }), 'rebuild');
assert.equal(playbackRecoveryAction({ status: { isLoaded: true, isPlaying: false, isBuffering: false }, phase: 'playing', isManuallyPaused: false }), 'resume');
assert.equal(playbackRecoveryAction({ status: { isLoaded: true, isPlaying: true }, phase: 'playing', isManuallyPaused: false }), 'none');
assert.equal(playbackRecoveryAction({ status: { isLoaded: false }, phase: 'playing', isManuallyPaused: true }), 'wait-for-user');
assert.equal(playbackRecoveryAction({ status: null, phase: 'paused', isManuallyPaused: false }), 'none');

const prepared = { ci: 2, pi: 7, voice: 'voice-a', rate: '+10%' };
assert.equal(preparedSoundMatches(prepared, {
  chapterIdx: 2, paragraphIdx: 7, voice: 'voice-a', rate: '+10%',
}), true);
assert.equal(preparedSoundMatches(prepared, {
  chapterIdx: 2, paragraphIdx: 8, voice: 'voice-a', rate: '+10%',
}), false);

assert.deepEqual(resolveNarrationStep({
  chapterIdx: 2, paragraphIdx: 3, direction: 1, chapterCount: 5, currentParagraphCount: 8,
}), { chapterIdx: 2, paragraphIdx: 4 });
assert.deepEqual(resolveNarrationStep({
  chapterIdx: 2, paragraphIdx: 7, direction: 1, chapterCount: 5, currentParagraphCount: 8,
}), { chapterIdx: 3, paragraphIdx: 0 });
assert.deepEqual(resolveNarrationStep({
  chapterIdx: 2, paragraphIdx: 0, direction: -1, chapterCount: 5,
  currentParagraphCount: 8, adjacentParagraphCount: 6,
}), { chapterIdx: 1, paragraphIdx: 5 });
assert.equal(resolveNarrationStep({
  chapterIdx: 0, paragraphIdx: 0, direction: -1, chapterCount: 5,
  currentParagraphCount: 8, adjacentParagraphCount: 0,
}), null);
assert.equal(preparedSoundMatches(prepared, {
  chapterIdx: 2, paragraphIdx: 7, voice: 'voice-b', rate: '+10%',
}), false);

console.log('listen playback tests passed');
