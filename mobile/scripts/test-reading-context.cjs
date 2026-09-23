const assert = require('node:assert/strict');
const {
  standardBlocksToContext,
  truncateAtParagraphBoundary,
} = require('../lib/readingContext');

const blocks = [
  { type: 'heading', text: '第三章 证据' },
  { type: 'text', text: '第一段说明当前页面正在讨论什么。' },
  { type: 'image', src: 'cover.jpg' },
  { type: 'table', rows: [['项目', '结论'], ['依据', '充分']] },
  { type: 'text', text: '第二段继续展开。' },
];
const context = standardBlocksToContext(blocks, 240);
assert.match(context, /第三章 证据/);
assert.match(context, /第一段说明/);
assert.match(context, /项目 \| 结论/);
assert.doesNotMatch(context, /cover\.jpg/);

const long = ['甲'.repeat(90), '乙'.repeat(90), '丙'.repeat(90)].join('\n\n');
const bounded = truncateAtParagraphBoundary(long, 200);
assert.equal(bounded, `${'甲'.repeat(90)}\n\n${'乙'.repeat(90)}`);
assert.ok(bounded.length <= 200);
assert.equal(truncateAtParagraphBoundary('短段。\n\n后一段。', 200), '短段。\n\n后一段。');
assert.equal(truncateAtParagraphBoundary('', 200), '');

console.log('reading context tests passed');
