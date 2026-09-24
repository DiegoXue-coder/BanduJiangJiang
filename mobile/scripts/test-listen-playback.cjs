const assert = require('node:assert/strict');
const {
  captionOpacityForIndex,
  captionVisualStateForSentence,
  centeredScrollOffset,
  playbackRecoveryAction,
  preparedSoundMatches,
  resolveNarrationStep,
  resolveJumpTarget,
  splitCaptionPhrases,
  rangeIndexAtOffset,
} = require('../lib/listenPlayback');

assert.equal(captionOpacityForIndex(3, 3), 1, '当前句必须首帧直接亮起');
assert.equal(captionOpacityForIndex(2, 3), 0.58);
assert.equal(captionOpacityForIndex(4, 3), 0.74);
assert.equal(captionVisualStateForSentence(3, 3), 1);
assert.equal(captionVisualStateForSentence(2, 3), 0);
assert.equal(captionVisualStateForSentence(4, 3), 2);
assert.deepEqual(
  [3, 3, 4].map((sentenceIndex) => captionVisualStateForSentence(sentenceIndex, 3)),
  [1, 1, 2],
  '同一句里的多个短语必须一起高亮，不能半句话一块一块变化',
);

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
assert.equal(playbackRecoveryAction({
  status: null, phase: 'playing', isManuallyPaused: false, voiceInteractionActive: true,
}), 'none', '语音问答期间回前台不得重建正文朗读');

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

assert.deepEqual(resolveJumpTarget({
  chunkLengths: [60, 55, 70], chapterIdx: 4, charOffset: 61,
}), { chapterIdx: 4, paragraphIdx: 1, charOffset: 1 }, '偏移落在第二块开头附近');
assert.deepEqual(resolveJumpTarget({
  chunkLengths: [60, 55, 70], chapterIdx: 4, charOffset: 0,
}), { chapterIdx: 4, paragraphIdx: 0, charOffset: 0 }, '偏移0落在第一块开头');
assert.deepEqual(resolveJumpTarget({
  chunkLengths: [60, 55, 70], chapterIdx: 4, charOffset: 59,
}), { chapterIdx: 4, paragraphIdx: 0, charOffset: 59 }, '偏移落在第一块最后一个字');
assert.deepEqual(resolveJumpTarget({
  chunkLengths: [60, 55, 70], chapterIdx: 4, charOffset: 10000,
}), { chapterIdx: 4, paragraphIdx: 2, charOffset: 70 }, '超出总长度兜底落在最后一块末尾');
assert.equal(resolveJumpTarget({ chunkLengths: [], chapterIdx: 0, charOffset: 5 }), null, '空章节没有可跳转的块');

const phraseText = '第一小段，第二小段：第三小段。最后一句';
const phrases = splitCaptionPhrases(phraseText, 24);
assert.deepEqual(phrases.map((item) => item.text), ['第一小段，', '第二小段：', '第三小段。', '最后一句']);
assert.equal(phrases.map((item) => item.text).join(''), phraseText, '短语切分不能增删正文字符');
assert(phrases.every((item, index) => index === 0 || item.start === phrases[index - 1].end), '短语字符范围必须连续');
assert.equal(rangeIndexAtOffset(phrases, 0), 0);
assert.equal(rangeIndexAtOffset(phrases, phrases[0].end), 1, '标点后的首字应进入下一短语');
assert.equal(rangeIndexAtOffset(phrases, phraseText.length + 50), phrases.length - 1);

const longPhrases = splitCaptionPhrases('甲'.repeat(53), 12);
assert.deepEqual(longPhrases.map((item) => item.text.length), [12, 12, 12, 12, 5], '无标点长句必须按最大长度兜底');
assert.equal(longPhrases.map((item) => item.text).join(''), '甲'.repeat(53));
assert(splitCaptionPhrases('乙'.repeat(45)).every((item) => item.text.length <= 14), '默认短语长度应适配小屏单行');

const quotedPhrases = splitCaptionPhrases('他说：“可以。”然后继续。', 24);
assert.equal(quotedPhrases[0].text, '他说：');
assert.equal(quotedPhrases[1].text, '“可以。”', '句末引号应跟随前面的自然停顿');
assert.equal(quotedPhrases.map((item) => item.text).join(''), '他说：“可以。”然后继续。');

console.log('listen playback tests passed');
