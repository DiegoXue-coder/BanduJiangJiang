const assert = require('assert');
const {
  appendPromptTurn,
  historyRowsToMessages,
  normalizeListenSettings,
  resolveListenChapter,
  resolveListenParagraph,
} = require('../lib/listenContinuity');

const chapters = [{ id: 10, title: '前言' }, { id: 11, title: '原则一' }];
assert.deepEqual(resolveListenChapter({
  progress: { chapter_kind: 'standard', chapter_id: 11, chapter_title: '旧标题' },
  chapters, chapterKind: 'standard', initialChapterTitle: '前言',
}), { chapterIdx: 1, useSavedPosition: true, source: 'saved-id' });
assert.deepEqual(resolveListenChapter({
  progress: { chapter_kind: 'standard', chapter_id: 99, chapter_title: '原则一' },
  chapters, chapterKind: 'standard', initialChapterTitle: '前言',
}), { chapterIdx: 1, useSavedPosition: true, source: 'saved-title' });
assert.equal(resolveListenChapter({
  progress: { chapter_kind: 'chapter', chapter_id: 11 },
  chapters, chapterKind: 'standard', initialChapterTitle: '前言',
}).source, 'reader');

assert.deepEqual(resolveListenParagraph(
  { paragraph_index: 1, char_offset: 3 }, ['第一段', '第二段文字'], true,
), { paragraphIdx: 1, charOffset: 3, source: 'saved' });
assert.deepEqual(resolveListenParagraph(
  { paragraph_index: 9, char_offset: 3 }, ['第一段'], true,
), { paragraphIdx: 0, charOffset: 0, source: 'saved-invalid' });
assert.deepEqual(resolveListenParagraph(
  { paragraph_index: 0, char_offset: 99 }, ['第一段'], true,
), { paragraphIdx: 0, charOffset: 0, source: 'saved-invalid' });

assert.deepEqual(normalizeListenSettings(
  { voice: 'voice-b', rate: '+35%' }, ['voice-a', 'voice-b'],
), { voice: 'voice-b', rate: '+35%' });
assert.deepEqual(normalizeListenSettings(
  { voice: 'unknown', rate: 'fast' }, ['voice-a'],
), { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' });

const restored = historyRowsToMessages([
  { question: '新问题', answer: '新回答' },
  { question: '旧问题', answer: '旧回答' },
], 2);
assert.deepEqual(restored.map((item) => item.content), ['旧问题', '旧回答', '新问题', '新回答']);
assert(restored.every((item) => item.historical));
const limited = appendPromptTurn(restored, '本次问题', '本次回答', 4);
assert.deepEqual(limited.map((item) => item.content), ['新问题', '新回答', '本次问题', '本次回答']);
assert(limited.every((item) => !Object.prototype.hasOwnProperty.call(item, 'historical')));

console.log('listen continuity tests passed');
