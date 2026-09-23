const assert = require('assert');
const vm = require('vm');
const { buildThemeInjection } = require('../lib/readerTheme');
const {
  findPageIndexForTarget,
  findTextMatchesInPayload,
  mergeParagraphsForReaderLocation,
  parseReaderLocation,
} = require('../lib/readerLocation');

function runTheme(script, sandbox) {
  vm.runInNewContext(script.replace(/true;\s*$/, ''), sandbox);
}

const messages = [];
const sandbox = {
  document: { documentElement: { style: {} }, body: { style: {} } },
  window: { ReactNativeWebView: { postMessage: (value) => messages.push(JSON.parse(value)) } },
};
runTheme(buildThemeInjection({ background: '#000', color: '#fff', version: 4 }, 'p1'), sandbox);
runTheme(buildThemeInjection({ background: '#fff', color: '#111', version: 3 }, 'p1'), sandbox);
assert.equal(sandbox.document.body.style.background, '#000', '旧主题不能覆盖新主题');
assert.equal(messages.at(-1).version, 4, '旧注入也必须回报页面当前的最新版本');
runTheme(buildThemeInjection({ background: '#eff7ec', color: '#1f2a20', version: 5 }, 'p1'), sandbox);
runTheme(buildThemeInjection({ background: '#f6edda', color: '#30271d', version: 6 }, 'p1'), sandbox);
runTheme(buildThemeInjection({ background: '#121416', color: '#ececec', version: 7 }, 'p1'), sandbox);
assert.equal(sandbox.document.body.style.background, '#121416', '快速连切后必须停在最后一次主题');
assert.equal(messages.at(-1).version, 7, '快速连切必须确认最后一个版本');

assert.deepEqual(parseReaderLocation('standard:12:7'), {
  kind: 'standard', chapterId: '12', paragraphIndex: 7,
});
assert.deepEqual(parseReaderLocation('listen:8:2'), {
  kind: 'listen', chapterId: '8', paragraphIndex: 2,
});
assert.deepEqual(parseReaderLocation('standard-progress:9:3'), {
  kind: 'progress', chapterId: '9', pageIndex: 3,
});

const payload = {
  paragraphs: ['第一句。', '第二句很长，继续补足到六十个字。第三句。'],
  blocks: [
    { type: 'text', text: '第一句。', sourceIndex: 0 },
    { type: 'text', text: '第二句很长，继续补足到六十个字。第三句。', sourceIndex: 1 },
  ],
};
assert.equal(findTextMatchesInPayload(payload, '第二句很长').length, 1);
assert.equal(mergeParagraphsForReaderLocation(payload.paragraphs).length, 1);
assert.equal(findTextMatchesInPayload(payload, '第一句。第二句很长').length, 1, '跨正文块原文可定位');
assert.equal(findTextMatchesInPayload({ paragraphs: ['重复句。', '重复句。'] }, '重复句。').length, 2, '重复原文不可误判为唯一位置');
assert.deepEqual(findPageIndexForTarget([
  [{ type: 'text', text: '第一句。', paragraphIndex: 0 }],
  [{ type: 'text', text: '第二句很长', paragraphIndex: 1 }],
], { paragraphIndex: 1, text: '第二句很长' }), { pageIndex: 1, matchedBy: 'text' });

console.log('reader reliability tests passed');
