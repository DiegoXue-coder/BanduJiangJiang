import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
  Modal, FlatList, PanResponder, Platform, useWindowDimensions, StatusBar,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Reader, useReader } from '@epubjs-react-native/core';
import { useFileSystem } from '@epubjs-react-native/expo-file-system';
import { WebView } from 'react-native-webview';
import { BottomSheetModal, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { IconList, IconMessageCircle, IconBrightness, IconTextSize, IconHeadphones } from '@tabler/icons-react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import {
  getBookContext, getBookFileUrl, getHighlights, saveHighlight, updateProgress, isLoggedIn, getChapterText, getStandardChapterText,
} from '../lib/api';
import { useTheme, setThemeMode } from '../theme';
import { FONT_ASSETS, FONTS } from '../fonts';
import { useAuthGate } from '../lib/authGate';
import BookChatScreen from './BookChatScreen';
import ReaderChrome, { READER_INFO_STRIP_HEIGHT } from '../components/ReaderChrome';
import StandardPager from '../components/StandardPager';
import SelectionPopup from '../components/SelectionPopup';

// 阶段十一：epub正文（书本原文内容）换成思源宋体——这部分渲染在
// react-native-webview内部，不是普通RN Text，普通expo-font的useFonts()
// 对它不生效，需要单独往WebView里注入@font-face引用字体文件的本地路径。
// 这部分是这次字体改造里唯一没法在任何预览环境验证的部分（epub渲染本身
// 在这个项目的沙盒预览里一直不稳定，是这个会话里反复记录过的已知限制），
// 需要真机确认实际效果，若加载失败WebView会静默回退到默认字体，不会白屏。
//
// 阶段十九：正文字体从"固定思源宋体"改成三选一（宋体/黑体/楷体，新增
// 霞鹜文楷）。family名字是自己起的字符串，只要跟下面注入的@font-face
// 声明和changeFontFamily调用保持一致就行，不需要跟字体文件本身的
// 内部命名一致。
const BODY_FONT_OPTIONS = [
  {
    key: 'serif',
    label: '宋体',
    family: 'SourceHanSerifSC',
    cssFamily: '"SourceHanSerifSC", "Songti SC", STSong, serif',
    previewFamily: Platform.select({ ios: 'Songti SC', android: FONTS.serifRegular, default: FONTS.serifRegular }),
    checkFamilies: ['Songti SC', 'SourceHanSerifSC'],
    asset: FONTS.serifRegular,
    profile: { weight: 400 },
    previewText: '宋',
  },
  {
    key: 'sans',
    label: '黑体',
    family: 'SourceHanSansSC',
    cssFamily: '"SourceHanSansSC", "PingFang SC", "Heiti SC", sans-serif',
    previewFamily: Platform.select({ ios: 'PingFang SC', android: FONTS.sansRegular, default: FONTS.sansRegular }),
    checkFamilies: ['PingFang SC', 'Heiti SC', 'SourceHanSansSC'],
    asset: FONTS.sansRegular,
    profile: { weight: 400 },
    previewText: '黑',
  },
  {
    key: 'kai',
    label: '楷体',
    family: 'LXGWWenKai',
    // 兜底用 serif 而不是 cursive：安卓的 cursive 只有拉丁手写体、没有中文映射，
    // 汉字会落到默认黑体（实测"楷体≡黑体"的原因之一）。子集字体之外的生僻字
    // 按字体栈逐字回退：iOS 落到 Kaiti SC，安卓落到系统衬线中文。
    cssFamily: '"LXGWWenKai", "Kaiti SC", STKaiti, KaiTi, serif',
    previewFamily: Platform.select({ ios: 'Kaiti SC', android: FONTS.kaiRegular, default: FONTS.kaiRegular }),
    checkFamilies: ['Kaiti SC', 'STKaiti', 'LXGWWenKai'],
    asset: FONTS.kaiRegular,
    profile: { weight: 400 },
    previewText: '楷',
  },
];

// 阶段十九：外壳视觉延伸（顶部工具栏/字号面板这类UI chrome），不动
// 上面这块正文渲染。等宽字体标数据是新版视觉语言（书架首页-未来感
// 设计稿.html）里明确强调的细节，这里只用在"16pt"这类数值型标签上，
// 不是给正文用的，正文字体走的是上面BODY_FONT_OPTIONS那一套三选一。
const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// 2026-08-06排版反馈：决策层用真实截图做before/after对比后确认，行高从
// 默认1.5调到1.75，三档主题（亮色/护眼/夜间）都要统一生效，不是只改一档。
const READING_LINE_HEIGHT = '1.75';

// 三套主题：亮色 / 暖纸色（护眼） / 深色，对应范围声明里确认的阅读体验要求
const THEMES = {
  light: { body: { background: '#ffffff', color: '#1a1a2e', 'line-height': READING_LINE_HEIGHT } },
  paper: { body: { background: '#f4ecd8', color: '#5b4636', 'line-height': READING_LINE_HEIGHT } },
  dark:  { body: { background: '#1a1a2e', color: '#dcdce6', 'line-height': READING_LINE_HEIGHT } },
  // 用户要求的"三级主题"：浅色/晚间各有几种底色可选（先做出来让用户体验，再决定保留哪些）。
  // 文字色跟着底色调过：浅色底配深墨色字，纯黑底的字色压暗一点（纯白字在纯黑底上太刺眼）。
  light_blue:  { body: { background: '#e6eef7', color: '#243447', 'line-height': READING_LINE_HEIGHT } },
  light_green: { body: { background: '#e2eedf', color: '#22352a', 'line-height': READING_LINE_HEIGHT } },
  dark_black:  { body: { background: '#000000', color: '#b9b9bd', 'line-height': READING_LINE_HEIGHT } },
  dark_gray:   { body: { background: '#2b2b2e', color: '#cfcfd3', 'line-height': READING_LINE_HEIGHT } },
};
// 旧的三档（iOS 的老主题面板还在用，也是历史设置里存的值）；新增的四个底色只在安卓沉浸式工具栏里选
const THEME_ORDER = ['light', 'paper', 'dark'];
// 每个主题属于哪一"大类"：决定全局界面色（theme.js 只有 light/eyecare/dark 三种模式）
const THEME_FAMILY = {
  light: 'light', light_blue: 'light', light_green: 'light',
  paper: 'paper',
  dark: 'dark', dark_black: 'dark', dark_gray: 'dark',
};
const THEME_MODE_BY_FAMILY = { light: 'light', paper: 'eyecare', dark: 'dark' };
// 沉浸式工具栏的"两级主题"：一级=大类（护眼/浅色/晚间），点了有多个底色的大类再展开二级
const IMMERSIVE_THEME_FAMILIES = [
  { key: 'paper', label: '护眼', variants: [{ key: 'paper', label: '暖纸', swatch: '#f4ecd8' }] },
  {
    key: 'light', label: '浅色',
    variants: [
      { key: 'light', label: '白', swatch: '#ffffff' },
      { key: 'light_blue', label: '浅蓝', swatch: '#e6eef7' },
      { key: 'light_green', label: '浅绿', swatch: '#e2eedf' },
    ],
  },
  {
    key: 'dark', label: '晚间',
    variants: [
      { key: 'dark', label: '深蓝', swatch: '#1a1a2e' },
      { key: 'dark_black', label: '纯黑', swatch: '#000000' },
      { key: 'dark_gray', label: '深灰', swatch: '#2b2b2e' },
    ],
  },
];
// 阶段十一：颜色/主题从"点一下循环切换"改成"三档横向切换控件"，标签跟着改
const THEME_SEGMENT_LABEL = { light: '默认', paper: '护眼模式', dark: '晚间阅读' };

// 字号调节：pt为单位，对应 epub.js rendition.themes.fontSize() 接受的CSS尺寸。
// 16pt是常见的默认阅读字号（比epub.js库自己的12pt默认值大，更适合国学爱好者
// 目标用户群体），12/28是给的合理上下限，避免调到读不出字或严重溢出。
const FONT_SIZE_DEFAULT = 16;
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 28;
const FONT_SIZE_STEP = 2;
const BODY_FONT_KEYS = BODY_FONT_OPTIONS.map((opt) => opt.key);
const BODY_FONT_CHECK_FAMILIES = BODY_FONT_OPTIONS.flatMap((opt) => opt.checkFamilies);

// 进度上报节流：翻页很频繁，没必要每次都请求后端
const PROGRESS_DEBOUNCE_MS = 2000;
const READER_FONT_STYLE_ID = 'chatbook-reader-font-override';
const READER_FONT_FACE_STYLE_ID = 'chatbook-reader-font-face';
const READER_SETTINGS_KEY = 'chatbook_reader_typography_settings_v1';
const READER_MODE_ORDER = ['epub', 'standard'];
const READER_MODE_LABEL = { epub: '原版', standard: '标准' };
const READER_DEFAULT_MODE = 'standard';
// 标准阅读的"整页滑动翻页容器"（跟手翻页、上一页/下一页常驻）启用的平台。
// 9/21 用户要求"安卓的设计和苹果同步"，苹果也启用。注意：苹果端是在**没有 iOS 真机/模拟器**的环境里
// 移植的（只做了打包和逻辑对照检查），如果苹果真机上翻页容器出问题，把 'ios' 从这个数组里去掉、
// 发一次 OTA，就退回到"每页一个 WebView"的旧做法（旧做法的代码还在，见下面渲染处）。
const STANDARD_PAGER_PLATFORMS = ['android', 'ios'];
// 阅读器"只有标准阅读模式"的平台（不再用原版 EPUB 模式）：导入的书用服务端拆好的标准章节，
// 公版书忽略手机里旧的"原版"选择。9/21 用户要求"苹果和安卓一样"，苹果也放开——之前苹果的导入书走原版
// EPUB 模式、公版书可能存着"原版"，所以苹果上阅读器一直是旧样子。服务端没有标准章节的旧书仍会退回原版 EPUB。
const STANDARD_ONLY_PLATFORMS = ['android', 'ios'];
const IS_STANDARD_ONLY = STANDARD_ONLY_PLATFORMS.includes(Platform.OS);
const STANDARD_PAGE_MIN_CHARS = 80;
const STANDARD_PAGE_MAX_CHARS = 430;
const STANDARD_READING_LINE_HEIGHT = 1.56;
const STANDARD_PROGRESS_PREFIX = 'standard-progress:';
const STANDARD_CHAPTER_CACHE_VERSION = 2;
const STANDARD_CHAPTER_MEMORY_CACHE = new Map();
const EPUB_FILE_CACHE_VERSION = 2;
const EPUB_BASE64_MEMORY_CACHE = new Map();
// 标准阅读正文字体的本地文件缓存（安卓）：把随包的子集字体复制到缓存目录的固定
// 文件名，页面 baseUrl 也指向该目录，保证 WebView 能用 file:// 读到字体（实测
// 最小权限只需 allowFileAccess + baseUrl，不必开 allowUniversalAccessFromFileURLs）。
// 文件名带资源 hash，换字体文件后自动失效，不会读到旧字体。
const READER_FONT_FILE_URIS = new Map(); // `${key}:${hash}` -> file:// 路径，进程内缓存
let ANDROID_FONT_FILE_MODE_FAILED = false; // 本次进程里 file:// 失败过就不再重试
const READER_LOADING_STAGES = [
  '准备书籍文件',
  '读取目录结构',
  '解析书籍内容',
  '应用阅读样式',
  '进入正文',
];
const EPUB_NON_READING_LABELS = ['cover', 'toc', 'nav', 'navigation', 'contents', '目录', '封面'];

function isLikelyEpubNonReadingTarget(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return EPUB_NON_READING_LABELS.some((label) => text.includes(label));
}

function findFirstReadableTocItem(items = []) {
  for (const item of items || []) {
    const label = item?.label || item?.title || item?.text || '';
    if (item?.href && !isLikelyEpubNonReadingTarget(label) && !isLikelyEpubNonReadingTarget(item.href)) {
      return item;
    }
    const child = findFirstReadableTocItem(item?.subitems || item?.children || []);
    if (child) return child;
  }
  return (items || []).find((item) => item?.href) || null;
}

function getReaderLoadingPercent(stageIndex, tick = 0) {
  const activeIndex = Math.max(0, Math.min(READER_LOADING_STAGES.length - 1, stageIndex));
  if (activeIndex >= READER_LOADING_STAGES.length - 1) return 100;
  const stageStart = activeIndex * 20;
  const gentleProgress = Math.min(18, 8 + tick * 2);
  return Math.min(96, stageStart + gentleProgress);
}

function parseReaderBridgeMessage(event) {
  if (!event) return null;
  if (event.type) return event;
  const raw = typeof event === 'string' ? event : (event?.nativeEvent?.data || event?.data);
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_e) {
    return null;
  }
}

function getStandardChapterCachePath(bookId, chapterId, mode = 'original') {
  return `${FileSystem.documentDirectory}reader_content_cache/v${STANDARD_CHAPTER_CACHE_VERSION}/book_${bookId}/${mode}_${chapterId}.json`;
}

function getEpubMemoryCacheKey(bookId, fileInfo) {
  return `${bookId}:${fileInfo?.size || 0}:${fileInfo?.modificationTime || 0}:v${EPUB_FILE_CACHE_VERSION}`;
}

async function readCachedStandardChapter(bookId, chapterId, mode = 'original') {
  const path = getStandardChapterCachePath(bookId, chapterId, mode);
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return null;
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STANDARD_CHAPTER_CACHE_VERSION) return null;
    if (String(parsed.bookId) !== String(bookId) || String(parsed.chapterId) !== String(chapterId)) return null;
    const payload = parsed.payload || null;
    return normalizeStandardBlocks(payload).length ? payload : null;
  } catch (_e) {
    return null;
  }
}

async function writeCachedStandardChapter(bookId, chapterId, payload, mode = 'original') {
  const path = getStandardChapterCachePath(bookId, chapterId, mode);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  await FileSystem.writeAsStringAsync(path, JSON.stringify({
    version: STANDARD_CHAPTER_CACHE_VERSION,
    bookId,
    chapterId,
    cachedAt: Date.now(),
    payload,
  }));
}

async function getCachedStandardChapterText(bookId, chapterId, options = {}) {
  const mode = options.standard ? 'standard' : 'original';
  const memoryKey = `${mode}:${bookId}:${chapterId}`;
  const memory = STANDARD_CHAPTER_MEMORY_CACHE.get(memoryKey);
  if (memory) return { ...memory, fromCache: true };
  const cached = await readCachedStandardChapter(bookId, chapterId, mode);
  if (cached) {
    STANDARD_CHAPTER_MEMORY_CACHE.set(memoryKey, cached);
    if (STANDARD_CHAPTER_MEMORY_CACHE.size > 10) {
      STANDARD_CHAPTER_MEMORY_CACHE.delete(STANDARD_CHAPTER_MEMORY_CACHE.keys().next().value);
    }
    return { ...cached, fromCache: true };
  }
  const data = options.standard
    ? await getStandardChapterText(bookId, chapterId)
    : await getChapterText(bookId, chapterId, options);
  const payload = {
    title: data?.title || '',
    paragraphs: Array.isArray(data?.paragraphs) ? data.paragraphs : [],
    blocks: normalizeStandardBlocks(data),
  };
  if (!payload.blocks.length) throw new Error('章节没有可阅读内容');
  await writeCachedStandardChapter(bookId, chapterId, payload, mode);
  STANDARD_CHAPTER_MEMORY_CACHE.set(memoryKey, payload);
  if (STANDARD_CHAPTER_MEMORY_CACHE.size > 10) {
    STANDARD_CHAPTER_MEMORY_CACHE.delete(STANDARD_CHAPTER_MEMORY_CACHE.keys().next().value);
  }
  return { ...payload, fromCache: false };
}

async function prepareImportedStandardBook(bookId, chapters, onProgress) {
  if (!chapters?.length) throw new Error('没有找到可阅读章节');
  const manifestPath = `${FileSystem.documentDirectory}reader_content_cache/v${STANDARD_CHAPTER_CACHE_VERSION}/book_${bookId}/manifest.json`;
  const chapterIds = chapters.map((chapter) => String(chapter.id));
  try {
    const manifest = JSON.parse(await FileSystem.readAsStringAsync(manifestPath));
    if (JSON.stringify(manifest.chapterIds) === JSON.stringify(chapterIds)) {
      onProgress(chapters.length, chapters.length);
      await getCachedStandardChapterText(bookId, chapters[0].id, { standard: true });
      if (chapters[1]) await getCachedStandardChapterText(bookId, chapters[1].id, { standard: true });
      return;
    }
  } catch (_e) {
    // First open or an incomplete previous download.
  }
  let nextIndex = 0;
  let completed = 0;
  onProgress(0, chapters.length);
  async function worker() {
    while (nextIndex < chapters.length) {
      const chapter = chapters[nextIndex++];
      await getCachedStandardChapterText(bookId, chapter.id, { standard: true });
      completed += 1;
      onProgress(completed, chapters.length);
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, chapters.length) }, () => worker()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  await FileSystem.writeAsStringAsync(manifestPath, JSON.stringify({ chapterIds }));
  await getCachedStandardChapterText(bookId, chapters[0].id, { standard: true });
  if (chapters[1]) await getCachedStandardChapterText(bookId, chapters[1].id, { standard: true });
}

function parseStandardProgressLocation(value, chapters = []) {
  const text = String(value || '');
  if (!text.startsWith(STANDARD_PROGRESS_PREFIX)) return null;
  const parts = text.slice(STANDARD_PROGRESS_PREFIX.length).split(':');
  if (parts.length < 2) return null;
  const chapterId = parts[0];
  const pageIndex = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(pageIndex)) return null;
  const chapterIndex = (chapters || []).findIndex((chapter) => String(chapter.id) === String(chapterId));
  if (chapterIndex < 0) return null;
  return { chapterIndex, pageIndex: Math.max(0, pageIndex) };
}

function jsStringLiteral(value) {
  return JSON.stringify(String(value ?? ''));
}

function buildReaderFontOverrideCss(cssFamily, profile = {}) {
  const weight = profile.weight || 400;
  return [
    `html, body { font-family: ${cssFamily} !important; line-height: ${READING_LINE_HEIGHT} !important; }`,
    `body, body *:not(svg):not(path) { font-family: ${cssFamily} !important; }`,
    `p, div, span, section, article, li, blockquote, td, th, a, em, strong, header, main { font-family: ${cssFamily} !important; font-weight: ${weight} !important; line-height: ${READING_LINE_HEIGHT} !important; }`,
    `h1, h2, h3, h4, h5, h6, nav h1 { font-family: ${cssFamily} !important; font-weight: 600 !important; }`,
  ].join(' ');
}

function normalizeStandardBlocks(data) {
  if (Array.isArray(data?.blocks) && data.blocks.length) {
    return data.blocks
      .map((block, index) => ({ ...block, sourceIndex: index }))
      .filter((block) => block.type === 'image' || block.type === 'table' || block.text || block.rows?.length);
  }
  return (data?.paragraphs || []).map((text, index) => ({ type: 'text', text, sourceIndex: index }));
}

function findStandardPageBreak(text, target) {
  if (text.length <= target) return text.length;
  const min = Math.max(24, Math.floor(target * 0.72));
  const max = Math.min(text.length, Math.floor(target * 1.08));
  const preferred = '。！？；：，、,.!?;:';
  for (let i = Math.min(max, text.length - 1); i >= min; i -= 1) {
    if (preferred.includes(text[i])) return i + 1;
  }
  return Math.max(min, Math.min(target, text.length));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStandardTextHtml(text, cfiRange, highlights) {
  return renderSelectableStandardText(text, cfiRange, highlights);
}

function splitStandardTokens(text) {
  const value = String(text || '');
  const tokens = [];
  let buffer = '';
  let latin = '';
  let bufferStart = 0;
  let latinStart = 0;
  let offset = 0;
  function pushLatin() {
    if (!latin) return;
    tokens.push({ text: latin, start: latinStart, end: latinStart + latin.length });
    latin = '';
  }
  function pushBuffer(force = false) {
    if (!buffer) return;
    if (force || buffer.length >= 2) {
      tokens.push({ text: buffer, start: bufferStart, end: bufferStart + buffer.length });
      buffer = '';
    }
  }
  for (const char of value) {
    if (/\s/.test(char)) {
      pushLatin();
      pushBuffer(true);
      tokens.push({ text: char, start: offset, end: offset + char.length });
      offset += char.length;
      continue;
    }
    if (/[A-Za-z0-9]/.test(char)) {
      pushBuffer(true);
      if (!latin) latinStart = offset;
      latin += char;
      offset += char.length;
      continue;
    }
    pushLatin();
    if (/[。！？；：，、,.!?;:（）()《》“”‘’]/.test(char)) {
      if (!buffer) bufferStart = offset;
      buffer += char;
      pushBuffer(true);
      offset += char.length;
      continue;
    }
    if (!buffer) bufferStart = offset;
    buffer += char;
    pushBuffer();
    offset += char.length;
  }
  pushLatin();
  pushBuffer(true);
  return tokens.filter((token) => token.text.length > 0);
}

function renderSelectableStandardText(text, cfiRange, highlights) {
  const value = String(text || '');
  const ranges = (highlights || [])
    .filter((h) => h.cfiRange === cfiRange && h.text)
    .map((h) => {
      const selected = String(h.text || '').trim();
      const start = selected ? value.indexOf(selected) : -1;
      return start >= 0 ? { start, end: start + selected.length } : null;
    })
    .filter(Boolean);
  return splitStandardTokens(value).map((token, index) => {
    if (/^\s+$/.test(token.text)) return escapeHtml(token.text);
    const highlighted = ranges.some((range) => token.start < range.end && token.end > range.start);
    const className = highlighted ? 'tok hl' : 'tok';
    return `<span class="${className}" data-idx="${index}">${escapeHtml(token.text)}</span>`;
  }).join('');
}

function buildStandardPageHtml({
  blocks,
  fontFamily,
  fontCssFamily,
  fontBase64,
  fontUrl,
  fontWeight,
  fontSize,
  lineHeight,
  theme,
  accent,
  highlights,
  chapterId,
  androidSelectionGuard,
  screenTopOffset = 0,
}) {
  // 字体来源二选一：fontUrl（本地文件 file://，安卓默认，HTML 里只有一行路径，
  // 翻页成本≈不加载字体）；fontBase64（内联 data URL，iOS 一直用这种，也是安卓
  // file:// 失败后的降级）。为什么不再往每页塞完整字体：标准阅读每翻一页都会
  // 重建 WebView，实测安卓上 HTML 超过约 14MB 就加载不出来（宋体/楷体完整版
  // 18.9MB/34MB 都不行，楷体甚至让进程被系统杀掉），黑体 13.5MB 能加载但每页 2.1s。
  const fontSrc = fontUrl
    ? `url("${fontUrl}")`
    : (fontBase64 ? `url("data:font/truetype;charset=utf-8;base64,${fontBase64}")` : '');
  const faceCss = fontSrc
    ? `@font-face{font-family:"${fontFamily}";src:${fontSrc} format("truetype");font-weight:${fontWeight};font-style:normal;}`
    : '';
  // 只有 file:// 方式才需要自检：字体没加载出来就通知 RN 降级成内联。
  const fontCheckScript = fontUrl
    ? `<script>
    (function(){
      function fail(){
        try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({type:'standardFontFailed'})); } catch(e) {}
      }
      try {
        document.fonts.load('16px "${fontFamily}"', '学而时习之').then(function(faces){
          if (!faces || !faces.length) fail();
        }).catch(fail);
      } catch(e) { fail(); }
    })();
  </script>`
    : '';
  const bodyHtml = (blocks || []).map((block) => {
    const cfiRange = block.type === 'text' ? `standard:${chapterId || 'unknown'}:${block.paragraphIndex}` : '';
    if (block.type === 'image') {
      return `<figure class="media"><img src="${escapeHtml(block.uri)}" /></figure>`;
    }
    if (block.type === 'table') {
      const rows = (block.rows || []).slice(0, 14).map((row) => (
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
      )).join('');
      return `<table>${rows}</table>`;
    }
    if (block.type === 'heading') {
      return `<h2>${escapeHtml(block.text)}</h2>`;
    }
    return `<p data-cfi="${escapeHtml(cfiRange)}">${renderStandardTextHtml(block.text, cfiRange, highlights)}</p>`;
  }).join('');
  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <style>
    ${faceCss}
    html,body{margin:0;padding:0;background:${theme.background};color:${theme.color};height:100%;overflow:hidden;-webkit-user-select:none;user-select:none;}
    body{font-family:${fontCssFamily};font-size:${fontSize}px;line-height:${lineHeight}px;-webkit-touch-callout:none;touch-action:manipulation;}
    #page{box-sizing:border-box;height:100vh;overflow:hidden;padding:12px 20px 8px;}
    p{margin:0 0 6px;}
    h2{margin:0 0 6px;color:${accent};font-size:17px;line-height:24px;font-weight:700;}
    mark{background:rgba(255,213,79,.38);color:inherit;padding:0 1px;}
    .tok{border-radius:2px;}
    .tok.hl{background:rgba(255,213,79,.38);}
    .tok.sel{background:rgba(217,155,68,.42);}
    figure.media{margin:2px 0 4px;height:72vh;display:flex;align-items:center;justify-content:center;}
    figure.media img{max-width:100%;max-height:100%;object-fit:contain;}
    table{width:100%;border-collapse:collapse;margin:4px 0;font-size:11px;line-height:16px;}
    td{border:1px solid currentColor;padding:5px 6px;vertical-align:top;}
  </style>
</head>
<body>
  <main id="page">${bodyHtml}</main>
  <script>
    (function(){
      var startX=0,startY=0,startT=0,moved=false,selecting=false,longTimer=null,anchor=null,focus=null,lastFocusKey='',selectedEls=[];
      var screenTop=${Number(screenTopOffset) || 0};
      var longPressMs=${androidSelectionGuard ? 720 : 320};
      var moveCancelPx=${androidSelectionGuard ? 10 : 22};
      function post(payload){
        try {
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        } catch(e) {}
      }
      function tokenFromPoint(x,y){
        var el=document.elementFromPoint(x,y);
        while(el && !(el.classList && el.classList.contains('tok'))) el=el.parentElement;
        if(el) return el;
        var tokens=document.querySelectorAll('p[data-cfi] .tok');
        var best=null,bestScore=999999;
        for(var i=0;i<tokens.length;i++){
          var r=tokens[i].getBoundingClientRect();
          if(!r || r.width<=0 || r.height<=0) continue;
          var yPad=Math.max(12, r.height * 0.75);
          var xPad=Math.max(8, r.height * 0.35);
          if(y >= r.top - yPad && y <= r.bottom + yPad){
            var dx=x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
            var dy=y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
            var score=dx + dy * 3;
            if(dx <= Math.max(80, r.width + xPad) && score < bestScore){
              best=tokens[i];
              bestScore=score;
            }
          }
        }
        return best;
      }
      function tokenMeta(el){
        if(!el) return null;
        var p=el.parentElement;
        while(p && !(p.dataset && p.dataset.cfi)) p=p.parentElement;
        if(!p) return null;
        return {el:el,p:p,cfiRange:p.dataset.cfi,idx:Number(el.dataset.idx)};
      }
      function allTokens(){
        return document.querySelectorAll('p[data-cfi] .tok');
      }
      function globalIndexOf(el){
        var tokens=allTokens();
        for(var i=0;i<tokens.length;i++) if(tokens[i]===el) return i;
        return -1;
      }
      function clearTokenSelection(){
        for(var i=0;i<selectedEls.length;i++) selectedEls[i].classList.remove('sel');
        var leftovers=document.querySelectorAll('.tok.sel');
        for(var j=0;j<leftovers.length;j++) leftovers[j].classList.remove('sel');
        selectedEls=[];
        lastFocusKey='';
      }
      window.__standardClearSelection=function(){
        clearTimeout(longTimer);
        longTimer=null;
        selecting=false;
        anchor=null;
        focus=null;
        clearTokenSelection();
      };
      function markTokenRange(){
        if(!anchor || !focus) return;
        var anchorIndex=globalIndexOf(anchor.el);
        var focusIndex=globalIndexOf(focus.el);
        if(anchorIndex<0 || focusIndex<0) return;
        var focusKey=String(focusIndex);
        if(focusKey===lastFocusKey) return;
        lastFocusKey=focusKey;
        clearTokenSelection();
        var start=Math.min(anchorIndex, focusIndex);
        var end=Math.max(anchorIndex, focusIndex);
        var tokens=allTokens();
        for(var i=start;i<=end;i++) if(tokens[i]) {
          tokens[i].classList.add('sel');
          selectedEls.push(tokens[i]);
        }
      }
      function selectedTokenFragments(){
        if(!anchor || !focus) return [];
        var anchorIndex=globalIndexOf(anchor.el);
        var focusIndex=globalIndexOf(focus.el);
        if(anchorIndex<0 || focusIndex<0) return [];
        var start=Math.min(anchorIndex, focusIndex);
        var end=Math.max(anchorIndex, focusIndex);
        var tokens=allTokens();
        var fragments=[];
        var currentCfi='';
        var currentText='';
        for(var i=start;i<=end;i++) if(tokens[i]) {
          var meta=tokenMeta(tokens[i]);
          if(!meta) continue;
          if(currentCfi && meta.cfiRange!==currentCfi){
            if(currentText.trim()) fragments.push({cfiRange:currentCfi,text:currentText.trim()});
            currentText='';
          }
          currentCfi=meta.cfiRange;
          currentText += tokens[i].textContent || '';
        }
        if(currentCfi && currentText.trim()) fragments.push({cfiRange:currentCfi,text:currentText.trim()});
        return fragments;
      }
      function endCustomSelection(){
        clearTimeout(longTimer);
        longTimer=null;
        if(!selecting) return false;
        var fragments=selectedTokenFragments();
        var parts=[];
        for(var i=0;i<fragments.length;i++) parts.push(fragments[i].text);
        var text=parts.join('\\n').trim();
        var cfiRange=fragments.length>1
          ? fragments[0].cfiRange + '..' + fragments[fragments.length-1].cfiRange
          : (fragments[0] && fragments[0].cfiRange) || (anchor && anchor.cfiRange);
        // 选中文字的位置（CSS 像素，相对页面视口）：RN 侧据此把"划线/问AI"小菜单摆在选中文字旁边。
        // 选区可能跨多行，所以量两个矩形：第一行那几个字（菜单默认摆在它上方）、
        // 最后一行那几个字（上方放不下时菜单摆在它下方）
        var rect=null, rectEnd=null;
        try {
          var selEls=document.querySelectorAll('.tok.sel');
          var rects=[];
          for(var k=0;k<selEls.length;k++){
            // 一个词元素可能被折成两行：getBoundingClientRect 会把两行包成一个大框，
            // 要用 getClientRects 拿逐行的小框
            var lines=selEls[k].getClientRects();
            for(var li=0;li<lines.length;li++){
              var rr=lines[li];
              if(rr && (rr.width || rr.height)) rects.push({l:rr.left,t:rr.top,r:rr.right,b:rr.bottom});
            }
          }
          if(rects.length){
            var minT=rects[0].t, maxT=rects[0].t;
            for(var m=1;m<rects.length;m++){ if(rects[m].t<minT) minT=rects[m].t; if(rects[m].t>maxT) maxT=rects[m].t; }
            var joinLine=function(top){
              var o=null;
              for(var q=0;q<rects.length;q++){
                if(Math.abs(rects[q].t-top)>4) continue;
                if(!o) o={l:rects[q].l,t:rects[q].t,r:rects[q].r,b:rects[q].b};
                else { o.l=Math.min(o.l,rects[q].l); o.t=Math.min(o.t,rects[q].t); o.r=Math.max(o.r,rects[q].r); o.b=Math.max(o.b,rects[q].b); }
              }
              return o;
            };
            rect=joinLine(minT);
            rectEnd=joinLine(maxT);
          }
        } catch(err) { rect=null; rectEnd=null; }
        selecting=false;
        anchor=null;
        focus=null;
        if(text) post({type:'standardSelection', text:text, cfiRange:cfiRange || 'standard:unknown', fragments:fragments, rect:rect, rectEnd:rectEnd, vw:window.innerWidth||0, vh:window.innerHeight||0});
        return true;
      }
      document.addEventListener('touchstart', function(e){
        try {
        var t=e.changedTouches[0]; startX=t.clientX; startY=t.clientY; startT=Date.now(); moved=false; lastFocusKey='';
        clearTimeout(longTimer);
        var meta=tokenMeta(tokenFromPoint(startX,startY));
        if(meta){
          longTimer=setTimeout(function(){
            selecting=true;
            anchor=meta;
            focus=meta;
            markTokenRange();
          }, longPressMs);
        }
        } catch(err) { post({type:'standardSelectionError'}); }
      }, {passive:true});
      document.addEventListener('touchmove', function(e){
        try {
        var t=e.changedTouches[0];
        var dx=t.clientX-startX, dy=t.clientY-startY;
        if(Math.abs(dx)>18 || Math.abs(dy)>18) moved=true;
        if(selecting){
          var meta=tokenMeta(tokenFromPoint(t.clientX,t.clientY));
          if(meta && anchor){
            focus=meta;
            markTokenRange();
          }
        } else if(longTimer && (Math.abs(dx)>moveCancelPx || Math.abs(dy)>moveCancelPx)){
          clearTimeout(longTimer);
          longTimer=null;
        }
        } catch(err) { post({type:'standardSelectionError'}); }
      }, {passive:true});
      document.addEventListener('touchend', function(e){
        try {
        if(endCustomSelection()) return;
        clearTimeout(longTimer);
        longTimer=null;
        var t=e.changedTouches[0], dx=t.clientX-startX, dy=t.clientY-startY;
        var held=Date.now()-startT;
        // 沉浸式：纵向滑动呼出/收起工具栏。规则（任务卡 08 §3.2）：竖向位移>=60px 且
        // 竖向>2×横向；按住>=350ms（长按）不识别；下滑起点在屏幕顶部边缘 24px 内不响应
        // （避开系统通知栏下拉）。"正在选字"的情况在上面 endCustomSelection 已经 return，
        // 选区取消前的判断（RN 侧 selection 状态）由 App 层再把一道关。
        if(Math.abs(dy)>=60 && Math.abs(dy)>Math.abs(dx)*2 && held<350){
          if(dy>0 && (startY+screenTop)<24) return;
          post({type:'standardVSwipe', dir: dy>0 ? 'down' : 'up'});
          return;
        }
        // 横向滑动：发独立的 standardSwipe 消息（和下面的边缘点击 standardPrev/Next 区分开）。
        // 启用了翻页容器时，横向拖动由容器的原生手势处理；苹果上手势库接管拖动后页面照样会收到 touchend，
        // 脚本这里就会重复触发一次翻页（用户反馈：往左翻到下一页后马上往右滑，会连翻两页），RN 侧据此去重。
        if(Math.abs(dx)>54 && Math.abs(dx)>Math.abs(dy)*1.45){ post({type:'standardSwipe', dir: dx<0 ? 1 : -1}); return; }
        if(!moved && held<420){
          var w=window.innerWidth || document.documentElement.clientWidth;
          if(t.clientX < w*.14) { clearTokenSelection(); post({type:'standardPrev'}); return; }
          if(t.clientX > w*.86) { clearTokenSelection(); post({type:'standardNext'}); return; }
          clearTokenSelection();
          // 点屏幕中间 30%~70% 呼出工具栏；工具栏展开时点正文收起（由 RN 侧按当前状态决定）
          var zone=(t.clientX>=w*.3 && t.clientX<=w*.7) ? 'center' : 'side';
          post({type:'standardBodyTap', zone:zone});
        }
        } catch(err) { post({type:'standardSelectionError'}); }
      }, {passive:true});
      // 安卓翻页容器接管横向拖动时，原生层会给页面发 touchcancel（不会再有 touchend）：
      // 把长按计时器和"移动过"标记复位，免得拖动结束后又冒出长按选字
      document.addEventListener('touchcancel', function(){
        clearTimeout(longTimer); longTimer=null; moved=false;
      }, {passive:true});
      document.addEventListener('message', function(e){
        if(e && e.data === 'standardClearSelection') window.__standardClearSelection();
      });
      window.addEventListener('message', function(e){
        if(e && e.data === 'standardClearSelection') window.__standardClearSelection();
      });
      document.addEventListener('touchcancel', function(){
        clearTimeout(longTimer);
        longTimer=null;
        selecting=false;
        anchor=null;
        focus=null;
        clearTokenSelection();
      }, {passive:true});
    })();
  </script>
  ${fontCheckScript}
</body>
</html>`;
}

function paginateStandardBlocks(blocks, fontSizePt, pageWidth, pageHeight, reservedHeight = 142) {
  const fontPx = Math.round(fontSizePt * 1.35);
  const usableWidth = Math.max(220, Number(pageWidth || 0) - 40);
  const usableHeight = Math.max(360, Number(pageHeight || 0) - reservedHeight);
  const estimatedLines = Math.max(9, Math.min(24, Math.floor(usableHeight / (fontPx * STANDARD_READING_LINE_HEIGHT))));
  const estimatedCharsPerLine = Math.max(9, Math.min(20, Math.floor(usableWidth / fontPx)));
  const pageBudget = Math.max(
    STANDARD_PAGE_MIN_CHARS,
    Math.min(STANDARD_PAGE_MAX_CHARS, estimatedLines * estimatedCharsPerLine),
  );
  const pages = [];
  let current = [];
  let count = 0;
  function blockWeight(block) {
    if (!block) return 0;
    if (block.type === 'image') return Math.floor(pageBudget * 0.62);
    if (block.type === 'table') {
      const rows = Array.isArray(block.rows) ? block.rows.length : 3;
      return Math.min(pageBudget, Math.max(Math.floor(pageBudget * 0.45), rows * 22));
    }
    const text = String(block.text || '').trim();
    if (!text) return 0;
    if (block.type === 'heading') return Math.max(20, Math.min(52, text.length + 18));
    return text.length;
  }
  function flush() {
    if (!current.length) return;
    pages.push(current);
    current = [];
    count = 0;
  }
  (blocks || []).forEach((block, blockIndex) => {
    const type = block?.type || 'text';
    if (type === 'image' || type === 'table') {
      const mediaBlock = { ...block, blockIndex };
      const weight = blockWeight(mediaBlock);
      if (current.length && count <= Math.floor(pageBudget * 0.32) && count + weight <= Math.floor(pageBudget * 1.05)) {
        current.push(mediaBlock);
        flush();
      } else {
        flush();
        pages.push([mediaBlock]);
      }
      return;
    }
    const text = String(block?.text || '').trim();
    if (!text) return;
    const paragraphIndex = Number.isFinite(block?.sourceIndex) ? block.sourceIndex : blockIndex;
    const isHeading = type === 'heading';
    const budget = pageBudget;
    const textBlock = { ...block, type, text, paragraphIndex, blockIndex };
    if (isHeading && current.length && count + blockWeight(textBlock) > Math.floor(pageBudget * 0.92)) {
      flush();
    }
    if (isHeading) {
      current.push(textBlock);
      count += blockWeight(textBlock);
      return;
    }
    let rest = text;
    while (rest.length) {
      const remaining = budget - count;
      if (current.length && remaining < Math.max(36, Math.floor(budget * 0.16))) {
        flush();
        continue;
      }
      if (rest.length <= remaining || !current.length) {
        const limit = current.length ? remaining : budget;
        if (rest.length <= limit) {
          current.push({ ...textBlock, text: rest });
          count += rest.length;
          rest = '';
        } else {
          const cut = findStandardPageBreak(rest, limit);
          current.push({ ...textBlock, text: rest.slice(0, cut) });
          count += cut;
          rest = rest.slice(cut).trimStart();
          flush();
        }
        continue;
      }
      const cut = findStandardPageBreak(rest, remaining);
      current.push({ ...textBlock, text: rest.slice(0, cut) });
      count += cut;
      rest = rest.slice(cut).trimStart();
      flush();
    }
  });
  flush();
  return pages.length ? pages : [[]];
}

function formatFontDiagnostics(payload, assetReport) {
  const lines = [];
  lines.push(`当前档位：${payload?.currentLabel || payload?.currentKey || '未知'}`);
  lines.push(`当前字体栈：${payload?.currentFamily || '未知'}`);
  lines.push(`rendition：${payload?.hasRendition ? '存在' : '不存在'}`);
  lines.push(`window.rendition：${payload?.hasWindowRendition ? '存在' : '不存在'}`);
  lines.push(`contents数量：${payload?.contentsCount ?? '未知'}`);
  if (assetReport?.length) {
    lines.push('');
    lines.push('RN字体资源：');
    assetReport.forEach((item) => {
      const sizeInfo = item.byteLength ? ` ${Math.round(item.byteLength / 1024)}KB` : '';
      lines.push(`- ${item.family}: ${item.ok ? 'OK' : 'FAIL'}${sizeInfo} ${item.url || item.error || ''}`);
    });
  }
  const docs = [payload?.outer, ...(payload?.contents || [])].filter(Boolean);
  if (docs.length) {
    lines.push('');
    lines.push('WebView正文状态：');
    docs.forEach((doc) => {
      lines.push(`- ${doc.index}: computed=${doc.computedFontFamily || '无'} body=${doc.bodyFontFamily || '无'}`);
      lines.push(`  style face=${doc.hasFaceStyle ? doc.faceCssLen : 0} override=${doc.hasOverrideStyle ? doc.overrideCssLen : 0} fonts=${doc.fontsStatus || '无'}`);
      if (doc.fontChecks) {
        lines.push(`  check=${Object.entries(doc.fontChecks).map(([k, v]) => `${k}:${v ? 'Y' : 'N'}`).join(' ')}`);
      }
      if (doc.sampleText) lines.push(`  sample=${doc.sampleText}`);
    });
  }
  if (payload?.error) {
    lines.push('');
    lines.push(`错误：${payload.error}`);
  }
  return lines.join('\n').slice(0, 4000);
}

// 目录树递归节点：不管epub.js给的toc有几层（章/节/小节，深度不固定），
// 都能正确展开/收起——上一版写死只渲染一层subitems，这次改成组件自己
// 递归调自己，depth决定缩进和字号（顶层稍大，往下逐级变淡变小，跟微信
// 读书那种"越深越次要"的视觉层级一致）。点标题本身跳转+关闭目录，点
// 箭头只展开/收起，两个操作分开，不会互相干扰（沿用之前就有的设计）。
function TocNode({ item, depth, pathKey, expandedToc, toggleTocExpanded, onSelect, theme }) {
  const subitems = item.subitems || [];
  const expanded = expandedToc.has(pathKey);
  return (
    <View>
      <View style={[
        styles.tocRow,
        depth > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.cardBorder },
      ]}>
        <TouchableOpacity
          style={[styles.tocRowMain, { paddingLeft: 16 + depth * 16 }]}
          onPress={() => onSelect(item.href)}
        >
          <Text
            style={[depth === 0 ? styles.tocItemText : styles.tocSubItemText, { color: depth === 0 ? theme.text : theme.textSecondary }]}
            numberOfLines={2}
          >
            {item.label?.trim()}
          </Text>
        </TouchableOpacity>
        {subitems.length > 0 && (
          <TouchableOpacity style={styles.tocChevronBtn} onPress={() => toggleTocExpanded(pathKey)}>
            <Text style={[styles.tocChevron, { color: theme.accent }]}>{expanded ? '︿' : '﹀'}</Text>
          </TouchableOpacity>
        )}
      </View>
      {expanded && subitems.map((sub, subIdx) => {
        const subKey = `${pathKey}_${sub.id || subIdx}`;
        return (
          <TocNode
            key={subKey}
            item={sub}
            depth={depth + 1}
            pathKey={subKey}
            expandedToc={expandedToc}
            toggleTocExpanded={toggleTocExpanded}
            onSelect={onSelect}
            theme={theme}
          />
        );
      })}
    </View>
  );
}

function ReaderInner({
  bookId, bookTitle, author, initialLocation, initialAnnotations, navigation,
  jumpToCfi, jumpNonce, epubSrc, epubError, chapters, standardChapters, bookSource,
}) {
  const windowSize = useWindowDimensions();
  // 1号任务诊断打点：这里挂载即代表epubUri（Base64字符串）已经通过RN桥
  // 传给了<Reader>，接下来是epub.js在WebView内部解压+解析的阶段——跟
  // handleReady里的打点配对，算出来的差值就是"WebView内部到底花了多久"，
  // 这一段之前完全是黑盒，只显示"正在下载书本…"这个笼统提示。
  const readerInnerMountedAtRef = useRef(Date.now());
  useEffect(() => {
    console.log(`[打开诊断] ReaderInner挂载，开始把EPUB交给WebView内的epub.js解析`);
  }, []);

  const { requireAuth } = useAuthGate();

  const { addAnnotation, changeTheme, changeFontSize, changeFontFamily, toc, goToLocation, goNext, goPrevious, injectJavascript, currentLocation } = useReader();

  // 目录跳转不能直接把 toc 里的 href（形如"chap_005.xhtml"）丢给 goToLocation——
  // 那个函数最终是调 epub.js 的 rendition.display(target)，虽然理论上支持
  // href，但翻源码（@epubjs-react-native/core 的 template.js）发现库自己内部
  // 处理"章节链接→跳转"时用的是专门的转换函数，先把 href 解析定位到具体的
  // CFI，再显示——照抄同样的做法，不直接信任 rendition.display(href) 能自己
  // 解析好。
  function goToTocItem(href) {
    injectJavascript(`
      (function() {
        try {
          var href = ${JSON.stringify(href)};
          var parts = href.split('#');
          var baseHref = parts[0];
          var id = parts[1];
          // 跟库内部 getCfiFromHref 一模一样的三段式兜底匹配——直接传 baseHref
          // 匹配不上时，试试"按/分割取第二段"（形如"OEBPS/xxx.xhtml"这种路径）、
          // 再试去掉第一段——我上一版只试了第一种，路径匹配不上就直接放弃，
          // 这次补全三种都试。
          var section = book.spine.get(baseHref.split('/')[1])
            || book.spine.get(baseHref)
            || book.spine.get(baseHref.split('/').slice(1).join('/'));
          if (!section) { rendition.display(href); return true; }
          section.load(book.load.bind(book)).then(function() {
            var el = id ? section.document.getElementById(id) : section.document.body;
            var cfi = section.cfiFromElement(el);
            rendition.display(cfi);
          }).catch(function() { rendition.display(href); });
        } catch (e) {}
      })();
      true;
    `);
  }
  const uiTheme = useTheme();
  const insets = useSafeAreaInsets();
  const [themeName, setThemeName] = useState('light');
  const [currentSectionTitle, setCurrentSectionTitle] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [epubReadyGateOpen, setEpubReadyGateOpen] = useState(false);
  // 阶段十：问AI从"跳转到独立页面"改成"底部弹出面板"，原文全程可见（半遮挡）。
  // chatParams 存这次要问的划线原文+cfi，present() 弹出面板时用。
  const [chatParams, setChatParams] = useState({ selection: '', cfiRange: '' });
  const chatSheetRef = useRef(null);
  // 诊断确认过：默认65%装不下完整内容，85%可以——回到验收标准要求的
  // 65%~78%区间，默认打开用较高的78%那档（78%比诊断用的85%略矮，但比
  // 原来不够用的65%高很多），两档保留，用户仍然可以手动拖拽到较矮的65%。
  const chatSnapPoints = useMemo(() => ['65%', '78%'], []);
  // 章节目录：epub.js 自动生成的导航页只有第一次打开书时会经过，选了某一章
  // 之后就没有入口再回去挑别的章节——加一个常驻的目录按钮，不依赖那个只会
  // 出现一次的自动导航页
  const [showToc, setShowToc] = useState(false);
  // 阶段十一bug修复：目录是纯 <Modal>，不挂在导航栈里，天生没有 iOS 那种
  // "从左边缘右滑返回"的手势——跟App其他页面的返回手势体验不一致，用户
  // 习惯性滑一下发现没反应，只能靠"完成"按钮退出。用 PanResponder 补一个
  // 右滑关闭手势（没用 react-native-gesture-handler/reanimated 那套，
  // 单纯检测一下拖拽距离用不着那么重，PanResponder是RN核心自带的，
  // 少一层跟原生模块版本对不上的风险）。
  // 2026-08-09真机反馈：目录条目全部是平铺的一层（章+章内小节混在一起），
  // 用户点开一本"一章一个文件、章内还有多个小节标题"的书（比如《负动产
  // 时代》）会看到几十条同级标题，分不清哪些是"章"哪些是隶属于某一章的
  // "节"。后端已经改成不再把章内小节拆成并列章节，改成epub.js原生支持的
  // 嵌套toc（章节条目的`subitems`数组装着它自己的小节）——这里配合改成
  // 可展开/收起的两层列表，默认收起（避免几十章×若干小节一次性铺开太长），
  // 点章节标题本身仍然是老行为：直接跳转+关闭目录；点右侧箭头只展开/收起，
  // 不跳转，两个操作分开，不会互相干扰。
  const [expandedToc, setExpandedToc] = useState(() => new Set());
  const toggleTocExpanded = useCallback((key) => {
    setExpandedToc((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const tocPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) =>
      Math.abs(gesture.dx) > 15 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2,
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx > 80) setShowToc(false);
    },
  }), []);
  // 阶段十一：颜色/字号两个图标点击后弹出的是同一排header下方的横向控件
  // （不是二级菜单），同一时间只显示一个，互斥
  const [showThemePanel, setShowThemePanel] = useState(false);
  const [showFontSizePanel, setShowFontSizePanel] = useState(false);
  const [fontSizePt, setFontSizePt] = useState(FONT_SIZE_DEFAULT);
  const [bodyFontKey, setBodyFontKey] = useState('serif');
  // 导入的书且服务端给了标准章节 → 走标准阅读（用标准章节）；否则（公版书/没有标准章节的旧导入书）用 EPUB 章节
  const importedStandard = IS_STANDARD_ONLY && bookSource === 'imported' && !!standardChapters?.length;
  const readingChapters = importedStandard ? standardChapters : chapters;
  const hasStandardChapters = Array.isArray(readingChapters) && readingChapters.length > 0;
  const defaultReaderMode = bookSource === 'imported'
    ? (importedStandard ? READER_DEFAULT_MODE : 'epub')
    : READER_DEFAULT_MODE;
  const [readerMode, setReaderMode] = useState(defaultReaderMode);
  // 沉浸式阅读器（任务卡 08 §3.2）：标准阅读模式下启用（安卓、苹果一致）；原版 EPUB 模式保持旧壳
  // （任务卡 §4 关于原版 EPUB 是否套壳的决策还没定）。用户 9/20 决定"先做安卓，再移植苹果"，9/21 要求同步苹果。
  const immersive = readerMode === 'standard';
  const pagerEnabled = STANDARD_PAGER_PLATFORMS.includes(Platform.OS);
  const [chromeOpen, setChromeOpen] = useState(false);
  const pendingSeekRef = useRef(null); // 进度条跳到别的章节时，等那一章加载完再定位到页
  const [standardChapterIndex, setStandardChapterIndex] = useState(0);
  const [standardPageIndex, setStandardPageIndex] = useState(0);
  const [standardChapterText, setStandardChapterText] = useState(null);
  const [standardChapterError, setStandardChapterError] = useState('');
  const [readerSettingsLoaded, setReaderSettingsLoaded] = useState(false);
  const [fontAssetReport, setFontAssetReport] = useState([]);
  const [standardFontBase64, setStandardFontBase64] = useState('');
  // 字体加载方式：安卓默认 'file'（本地文件），失败降级 'inline'（只内联当前一个
  // 子集字体）；iOS 一直是 'inline'（原来的做法，字体变小后自然更快）。
  const [standardFontMode, setStandardFontMode] = useState(
    Platform.OS === 'android' && !ANDROID_FONT_FILE_MODE_FAILED ? 'file' : 'inline',
  );
  const [standardFontUris, setStandardFontUris] = useState({}); // { serif, sans, kai } -> file://
  // 长按原生菜单（menuItems）在拖动选区手柄调整范围后不会重新弹出——这是
  // react-native-webview 自身的已知限制，不是我们代码能修的。改用这个悬浮条
  // 兜底：只要 epub.js 报了新的选区（onSelected，拖动调整后也会正常触发），
  // 就显示"划线/问AI"按钮，不依赖那个容易失效的原生菜单。
  const [selection, setSelection] = useState(null); // { text, cfiRange }
  const [standardSavedHighlights, setStandardSavedHighlights] = useState([]);
  const [readerLoadingTick, setReaderLoadingTick] = useState(0);
  const progressTimer = useRef(null);
  const standardSelectionTimerRef = useRef(null);
  // 现在指向翻页容器（StandardPager）；它对外提供 injectJavaScript，只作用于"当前页"
  const standardWebViewRef = useRef(null);
  const standardPagerRef = standardWebViewRef;
  // 翻页动画进行中又点了一下：记下来，动画一结束（页码变了）就接着翻，
  // 不然连点会"吞"掉点击。同方向最多攒 3 下（再多就是乱点了），方向变了就重新计。
  const queuedTurnRef = useRef({ dir: 0, n: 0 });
  // 翻页容器最近一次开始拖动/完成翻页的时间：脚本的滑动消息如果紧跟在它后面，就是重复触发，要丢掉
  const lastPagerTurnAtRef = useRef(0);
  const queueTurn = (dir) => {
    const q = queuedTurnRef.current;
    queuedTurnRef.current = q.dir === dir ? { dir, n: Math.min(3, q.n + 1) } : { dir, n: 1 };
  };
  // 往前翻进上一章时，要直接落在上一章的最后一页（不是第一页）
  const landingPageRef = useRef(null);
  // 相邻章节预读完成后 +1，触发重新渲染，让翻页容器拿到上一页/下一页
  const [, setPrefetchTick] = useState(0);
  const annotationsRestored = useRef(false);
  const skippedInitialNav = useRef(false);
  const initialStandardLocationApplied = useRef(false);
  const pendingStandardPageIndex = useRef(null);

  useEffect(() => () => {
    if (standardSelectionTimerRef.current) clearTimeout(standardSelectionTimerRef.current);
    if (progressTimer.current) clearTimeout(progressTimer.current);
  }, []);

  useEffect(() => {
    setIsReady(false);
    setEpubReadyGateOpen(false);
    annotationsRestored.current = false;
    skippedInitialNav.current = false;
    initialStandardLocationApplied.current = false;
    pendingStandardPageIndex.current = null;
  }, [epubSrc]);

  useEffect(() => {
    initialStandardLocationApplied.current = false;
    pendingStandardPageIndex.current = null;
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(READER_SETTINGS_KEY)
      .then((raw) => {
        if (cancelled) return;
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (BODY_FONT_KEYS.includes(saved.bodyFontKey)) {
          setBodyFontKey(saved.bodyFontKey);
        }
        if (THEMES[saved.themeName]) {
          setThemeName(saved.themeName);
          setThemeMode(THEME_MODE_BY_FAMILY[THEME_FAMILY[saved.themeName]]);
        }
        if (!IS_STANDARD_ONLY && bookSource !== 'imported' && READER_MODE_ORDER.includes(saved.readerMode)) {
          setReaderMode(saved.readerMode);
        } else {
          setReaderMode(defaultReaderMode);
        }
        if (
          Number.isFinite(saved.fontSizePt) &&
          saved.fontSizePt >= FONT_SIZE_MIN &&
          saved.fontSizePt <= FONT_SIZE_MAX
        ) {
          setFontSizePt(saved.fontSizePt);
        }
      })
      .catch((e) => console.warn('[阅读器设置] 读取失败', e.message || e))
      .finally(() => {
        if (!cancelled) setReaderSettingsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [bookSource, defaultReaderMode]);

  useEffect(() => {
    if (!readerSettingsLoaded) return;
    SecureStore.setItemAsync(READER_SETTINGS_KEY, JSON.stringify({ bodyFontKey, fontSizePt, themeName, readerMode }))
      .catch((e) => console.warn('[阅读器设置] 保存失败', e.message || e));
  }, [readerSettingsLoaded, bodyFontKey, fontSizePt, themeName, readerMode]);

  useEffect(() => {
    setStandardSavedHighlights(
      (initialAnnotations || [])
        .filter((h) => h.cfi_location?.startsWith('standard:') && h.highlighted_text)
        .map((h) => ({ cfiRange: h.cfi_location, text: h.highlighted_text })),
    );
  }, [initialAnnotations]);

  // 安卓：把三个子集字体准备成本地文件（一次性，之后切字体不用等）。
  // 之前（9/19 起）安卓导入书干脆不加载字体，导致宋/黑/楷三者靠系统字体兜底、
  // 看起来一样；现在用本地文件方式，页面 HTML 里只有一行路径，翻页成本≈没字体。
  useEffect(() => {
    if (Platform.OS !== 'android' || standardFontMode !== 'file') return undefined;
    let cancelled = false;
    (async () => {
      const next = {};
      for (const opt of BODY_FONT_OPTIONS) {
        const asset = await Asset.fromModule(FONT_ASSETS[opt.asset]).downloadAsync();
        const cacheKey = `${opt.key}:${asset.hash || 'nohash'}`;
        let uri = READER_FONT_FILE_URIS.get(cacheKey);
        if (!uri) {
          const src = asset.localUri || asset.uri;
          const dst = `${FileSystem.cacheDirectory}reader-font-${opt.key}-${asset.hash || 'nohash'}.ttf`;
          const info = await FileSystem.getInfoAsync(dst);
          if (!info.exists) await FileSystem.copyAsync({ from: src, to: dst });
          uri = dst;
          READER_FONT_FILE_URIS.set(cacheKey, uri);
        }
        next[opt.key] = uri;
      }
      if (!cancelled) setStandardFontUris(next);
    })().catch((e) => {
      console.warn('[标准阅读字体] 本地文件方式准备失败，降级为内联', e.message || e);
      ANDROID_FONT_FILE_MODE_FAILED = true;
      if (!cancelled) setStandardFontMode('inline');
    });
    return () => { cancelled = true; };
  }, [standardFontMode]);

  // 内联方式（iOS 一直用；安卓仅在本地文件方式失败后降级用）：只读取当前选中的
  // 那一个字体，转 base64 塞进页面。字体已是子集（3~5MB），不再是原来的 10~25MB。
  useEffect(() => {
    if (standardFontMode !== 'inline') return undefined;
    let cancelled = false;
    const currentOpt = BODY_FONT_OPTIONS.find((o) => o.key === bodyFontKey) || BODY_FONT_OPTIONS[0];
    Asset.fromModule(FONT_ASSETS[currentOpt.asset]).downloadAsync()
      .then(async (asset) => {
        const url = asset.localUri || asset.uri;
        return FileSystem.readAsStringAsync(url, { encoding: FileSystem.EncodingType.Base64 });
      })
      .then((base64) => {
        if (!cancelled) setStandardFontBase64(base64);
      })
      .catch((e) => {
        console.warn('[标准阅读字体] 加载失败', e.message || e);
        if (!cancelled) setStandardFontBase64('');
      });
    return () => { cancelled = true; };
  }, [bodyFontKey, standardFontMode]);

  useEffect(() => {
    if (readerMode !== 'standard') return;
    const chapter = readingChapters?.[standardChapterIndex];
    if (!chapter) {
      setStandardChapterError('没有找到可阅读章节');
      return;
    }
    let cancelled = false;
    setStandardChapterError('');
    const cacheMode = importedStandard ? 'standard' : 'original';
    const memory = STANDARD_CHAPTER_MEMORY_CACHE.get(`${cacheMode}:${bookId}:${chapter.id}`);
    setStandardChapterText(memory ? { ...memory, title: memory.title || chapter.title || '', chapterId: chapter.id } : null);
    setStandardPageIndex(landingPageRef.current ?? 0);
    landingPageRef.current = null;
    setCurrentSectionTitle(chapter.title || '');
    getCachedStandardChapterText(bookId, chapter.id, { includeBlocks: true, standard: importedStandard })
      .then((data) => {
        if (cancelled) return;
        const blocks = normalizeStandardBlocks(data);
        if (!blocks.length) throw new Error('章节没有可阅读内容');
        console.log(`[标准阅读缓存] 章节${chapter.id} ${data?.fromCache ? '命中' : '写入'}缓存`);
        setStandardChapterText({
          title: data?.title || chapter.title || '',
          paragraphs: Array.isArray(data?.paragraphs) ? data.paragraphs : [],
          blocks,
          chapterId: chapter.id,
        });
        if (pendingStandardPageIndex.current !== null) {
          setStandardPageIndex(pendingStandardPageIndex.current);
          pendingStandardPageIndex.current = null;
        }
        const nextChapter = readingChapters?.[standardChapterIndex + 1];
        if (nextChapter?.id) {
          getCachedStandardChapterText(bookId, nextChapter.id, { includeBlocks: true, standard: importedStandard })
            .catch((e) => console.warn('[标准阅读缓存] 下一章预热失败', e.message || e));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setStandardChapterError(e.message || '章节加载失败');
      });
    return () => { cancelled = true; };
  }, [readerMode, readingChapters, standardChapterIndex, bookId, bookSource]);

  useEffect(() => {
    if (readerMode !== 'standard') return;
    if (initialStandardLocationApplied.current) return;
    if (!readingChapters || readingChapters.length === 0) return;
    initialStandardLocationApplied.current = true;
    const loc = parseStandardProgressLocation(initialLocation, readingChapters);
    if (!loc) return;
    pendingStandardPageIndex.current = loc.pageIndex;
    setStandardChapterIndex(loc.chapterIndex);
    setCurrentSectionTitle(readingChapters[loc.chapterIndex]?.title || '');
  }, [readerMode, initialLocation, readingChapters]);

  // initialAnnotations 要等 Reader 的 onReady 触发（book 真正渲染完成）才能加，
  // 提前调用 addAnnotation 会静默失效，所以不能放进 mount 时的 effect 里。
  //
  // 真机反馈"not a valid argument for epubcfi"：ListenScreen听书功能打断
  // 提问时，会把截取的段落存成一条highlights记录，但那边没有真实epub.js
  // CFI可用（没有驱动WebView渲染，只是纯数据段落），用的是"listen:章节id:
  // 段落序号"这种自造的占位格式，不是真CFI。这条记录混进这本书的划线
  // 列表后，阅读器打开时这个循环会把它也传给addAnnotation，epub.js内部
  // 解析CFI字符串失败直接抛错，会阻断循环导致后面真正的划线也加不上。
  // 真实CFI固定以"epubcfi("开头（EPUB CFI规范），过滤掉不是这个格式的
  // 记录，不传给addAnnotation——这类划线本来就没法在阅读器里精确定位
  // 展示，跳过是合理的，不是丢数据（数据库里还在，只是不在阅读器里画
  // 高亮框）。
  function handleReady() {
    console.log(`[打开诊断] epub.js onReady触发，WebView内部解析耗时=${Date.now() - readerInnerMountedAtRef.current}ms`);
    setIsReady(true);
    if (annotationsRestored.current) return;
    annotationsRestored.current = true;
    for (const h of initialAnnotations) {
      if (!h.cfi_location || !h.cfi_location.startsWith('epubcfi(')) continue;
      addAnnotation('highlight', h.cfi_location, { id: h.id }, { color: '#ffd54f' });
    }
  }

  // 正文字体：真机多轮诊断后确认，单纯把Expo资产的file://路径写进
  // WKWebView里的@font-face不够可靠，computed font-family可能显示成
  // 目标family，但真实字形仍静默回退。这里改成只读取"当前选中的字体"，
  // 以内嵌data URL的方式注入到EPUB正文document，先保证字形确实可见。
  useEffect(() => {
    if (!isReady) return;
    if (Platform.OS === 'android') {
      const currentOpt = BODY_FONT_OPTIONS.find((o) => o.key === bodyFontKey) || BODY_FONT_OPTIONS[0];
      setFontAssetReport([{
        family: currentOpt.family,
        ok: true,
        skippedDataUrl: true,
        note: 'Android EPUB 使用轻量 CSS 字体族，不注入大体积字体文件',
      }]);
      return;
    }
    let cancelled = false;
    const currentOpt = BODY_FONT_OPTIONS.find((o) => o.key === bodyFontKey) || BODY_FONT_OPTIONS[0];
    Asset.fromModule(FONT_ASSETS[currentOpt.asset]).downloadAsync()
      .then(async (asset) => {
        const url = asset.localUri || asset.uri;
        const base64 = await FileSystem.readAsStringAsync(url, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return {
          family: currentOpt.family,
          url,
          localUri: asset.localUri,
          uri: asset.uri,
          byteLength: Math.round(base64.length * 0.75),
          base64,
          ok: true,
        };
      })
      .catch((e) => ({
        family: currentOpt.family,
        url: '',
        ok: false,
        error: e.message || String(e),
      }))
      .then((result) => {
      if (cancelled) return;
      setFontAssetReport([result]);
      if (!result.ok || !result.base64) return;
      const rules = `@font-face { font-family: "${currentOpt.family}"; src: url("data:font/truetype;charset=utf-8;base64,${result.base64}") format("truetype"); font-weight: ${currentOpt.profile.weight || 400}; font-style: normal; }`;
      const currentCss = buildReaderFontOverrideCss(currentOpt.cssFamily, currentOpt.profile);
      injectJavascript(`
        (function() {
          try {
            var faceId = ${jsStringLiteral(READER_FONT_FACE_STYLE_ID)};
            var overrideId = ${jsStringLiteral(READER_FONT_STYLE_ID)};
            var faceCss = ${jsStringLiteral(rules)};
            function installStyle(doc, id, css) {
              if (!doc || !doc.head) return;
              var style = doc.getElementById(id);
              if (!style) {
                style = doc.createElement('style');
                style.id = id;
                doc.head.appendChild(style);
              }
              style.innerHTML = css;
            }
            function installFontFace(doc) {
              installStyle(doc, faceId, faceCss);
            }
            function applyFont(doc, family) {
              installFontFace(doc);
              installStyle(
                doc,
                overrideId,
                window.__chatbookReaderFontCss || ${jsStringLiteral(currentCss)}
              );
            }
            function getReaderRendition() {
              if (typeof rendition !== 'undefined' && rendition) return rendition;
              if (window.rendition) return window.rendition;
              return null;
            }
            window.__chatbookApplyReaderFont = function(cssFamily) {
              applyFont(document, cssFamily);
              var r = getReaderRendition();
              if (r && typeof r.getContents === 'function') {
                r.getContents().forEach(function(contents) {
                  applyFont(contents && contents.document, cssFamily);
                });
              }
              console.log('[字体诊断] 已应用正文字体 ' + cssFamily);
            };
            var readerRendition = getReaderRendition();
            if (!window.__chatbookFontRenderedHook && readerRendition && typeof readerRendition.on === 'function') {
              window.__chatbookFontRenderedHook = true;
              readerRendition.on('rendered', function(section, contents) {
                var family = window.__chatbookReaderFontFamily || ${jsStringLiteral(currentOpt.cssFamily)};
                if (contents && contents.document) {
                  applyFont(contents.document, family);
                } else {
                  window.__chatbookApplyReaderFont(family);
                }
              });
            }
            window.__chatbookReaderFontFamily = ${jsStringLiteral(currentOpt.cssFamily)};
            window.__chatbookReaderFontCss = ${jsStringLiteral(currentCss)};
            window.__chatbookApplyReaderFont(window.__chatbookReaderFontFamily);
          } catch (e) {}
        })();
        true;
      `);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, bodyFontKey]);

  function requestFontDiagnostics() {
    const opt = BODY_FONT_OPTIONS.find((o) => o.key === bodyFontKey) || BODY_FONT_OPTIONS[0];
    injectJavascript(`
      (function() {
        function post(payload) {
          var message = JSON.stringify({ type: 'chatbookFontDiagnostics', payload: payload });
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(message);
          } else if (typeof reactNativeWebview !== 'undefined' && reactNativeWebview.postMessage) {
            reactNativeWebview.postMessage(message);
          }
        }
        function summarizeDoc(doc, index, family) {
          if (!doc) return { index: index, missing: true };
          var faceId = ${jsStringLiteral(READER_FONT_FACE_STYLE_ID)};
          var overrideId = ${jsStringLiteral(READER_FONT_STYLE_ID)};
          var sample = doc.querySelector('p, div, section, article, body');
          var computed = sample ? doc.defaultView.getComputedStyle(sample) : null;
          var bodyComputed = doc.body ? doc.defaultView.getComputedStyle(doc.body) : null;
          var checks = {};
          ${jsStringLiteral(BODY_FONT_CHECK_FAMILIES.join('|'))}.split('|').forEach(function(name) {
            try {
              checks[name] = !!(doc.fonts && doc.fonts.check && doc.fonts.check('16px "' + name + '"'));
            } catch (e) {
              checks[name] = false;
            }
          });
          return {
            index: index,
            href: doc.location && doc.location.href,
            title: doc.title || '',
            sampleTag: sample && sample.tagName,
            sampleText: sample && sample.textContent ? sample.textContent.trim().slice(0, 42) : '',
            computedFontFamily: computed && computed.fontFamily,
            bodyFontFamily: bodyComputed && bodyComputed.fontFamily,
            hasFaceStyle: !!doc.getElementById(faceId),
            faceCssLen: doc.getElementById(faceId) ? doc.getElementById(faceId).innerHTML.length : 0,
            hasOverrideStyle: !!doc.getElementById(overrideId),
            overrideCssLen: doc.getElementById(overrideId) ? doc.getElementById(overrideId).innerHTML.length : 0,
            fontsStatus: doc.fonts ? doc.fonts.status : 'no-fonts-api',
            selectedCheck: !!(doc.fonts && doc.fonts.check && doc.fonts.check('16px "' + family + '"')),
            fontChecks: checks
          };
        }
        try {
          var family = ${jsStringLiteral(opt.cssFamily)};
          var readerRendition = null;
          if (typeof rendition !== 'undefined' && rendition) readerRendition = rendition;
          else if (window.rendition) readerRendition = window.rendition;
          var contents = readerRendition && typeof readerRendition.getContents === 'function'
            ? readerRendition.getContents()
            : [];
          post({
            currentKey: ${jsStringLiteral(opt.key)},
            currentLabel: ${jsStringLiteral(opt.label)},
            currentFamily: window.__chatbookReaderFontFamily || family,
            hasRendition: !!readerRendition,
            hasWindowRendition: !!window.rendition,
            contentsCount: contents.length,
            outer: summarizeDoc(document, 'outer', family),
            contents: contents.map(function(contents, idx) {
              return summarizeDoc(contents && contents.document, idx, family);
            })
          });
        } catch (e) {
          post({
            currentKey: ${jsStringLiteral(opt.key)},
            currentLabel: ${jsStringLiteral(opt.label)},
            currentFamily: ${jsStringLiteral(opt.cssFamily)},
            error: e.message || String(e)
          });
        }
      })();
      true;
    `);
  }

  function handleReaderWebViewMessage(event) {
    const message = parseReaderBridgeMessage(event);
    if (message?.type === 'chatbookClearAccidentalSelection') {
      setSelection(null);
      return;
    }
    if (message?.type === 'chatbookReaderContentReady') {
      setEpubReadyGateOpen(true);
      return;
    }
    if (message?.type !== 'chatbookFontDiagnostics') return;
    Alert.alert('字体诊断', formatFontDiagnostics(message.payload, fontAssetReport));
  }

  useEffect(() => {
    if (readerMode !== 'epub' || !isReady || epubReadyGateOpen) return undefined;
    const fallback = setTimeout(() => {
      openEpubReadyGate('ready-fallback');
    }, 2200);
    let tries = 0;
    const probe = () => {
      tries += 1;
      injectJavascript(`
        (function() {
          function postReady(payload) {
            var message = JSON.stringify({ type: 'chatbookReaderContentReady', payload: payload });
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(message);
            } else if (typeof reactNativeWebview !== 'undefined' && reactNativeWebview.postMessage) {
              reactNativeWebview.postMessage(message);
            }
          }
          function isNonReading(value) {
            var text = String(value || '').trim().toLowerCase();
            if (!text) return false;
            return ${jsStringLiteral(EPUB_NON_READING_LABELS.join('|'))}.split('|').some(function(label) {
              return text.indexOf(label) >= 0;
            });
          }
          function summarize(doc, index) {
            if (!doc || !doc.body) return null;
            var text = (doc.body.textContent || '').replace(/\\s+/g, ' ').trim();
            var title = doc.title || '';
            var href = doc.location && doc.location.href || '';
            return {
              index: index,
              title: title,
              href: href,
              textLen: text.length,
              links: doc.querySelectorAll ? doc.querySelectorAll('a[href]').length : 0,
              paragraphs: doc.querySelectorAll ? doc.querySelectorAll('p, section, article, div').length : 0,
              nonReading: isNonReading(title) || isNonReading(href),
            };
          }
          try {
            var readerRendition = null;
            if (typeof rendition !== 'undefined' && rendition) readerRendition = rendition;
            else if (window.rendition) readerRendition = window.rendition;
            var contents = readerRendition && typeof readerRendition.getContents === 'function'
              ? readerRendition.getContents()
              : [];
            var docs = [];
            contents.forEach(function(content, idx) {
              docs.push(summarize(content && content.document, idx));
            });
            var readable = docs.filter(Boolean).find(function(item) {
              return item.textLen >= 40 && !item.nonReading && item.paragraphs > 0;
            });
            if (readable) {
              postReady({ readable: readable, contentsCount: contents.length });
            }
          } catch (e) {}
        })();
        true;
      `);
    };
    probe();
    const timer = setInterval(() => {
      if (tries >= 18) {
        clearInterval(timer);
        openEpubReadyGate('probe-timeout');
        return;
      }
      probe();
    }, 700);
    return () => {
      clearTimeout(fallback);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerMode, isReady, epubReadyGateOpen]);

  // 字体选择变化时单独切换生效字体。真机反馈过一次：按钮选中态在变，
  // 但正文看起来完全没变。只调epub.js的changeFontFamily不够稳，因为
  // 原书HTML/CSS经常自己写了font-family，优先级会盖过主题设置。这里
  // 再往WebView里放一条带!important的覆盖样式，强制正文常见元素跟随
  // 当前选择；保留changeFontFamily作为epub.js主题层的同步设置。
  useEffect(() => {
    if (!isReady) return;
    const opt = BODY_FONT_OPTIONS.find((o) => o.key === bodyFontKey) || BODY_FONT_OPTIONS[0];
    const overrideCss = buildReaderFontOverrideCss(opt.cssFamily, opt.profile);
    if (Platform.OS !== 'android') {
      changeFontFamily(opt.cssFamily);
    }
    injectJavascript(`
      (function() {
        try {
          var id = ${jsStringLiteral(READER_FONT_STYLE_ID)};
          var family = ${jsStringLiteral(opt.cssFamily)};
          var overrideCss = ${jsStringLiteral(overrideCss)};
          function installStyle(doc) {
            if (!doc || !doc.head) return;
            var style = doc.getElementById(id);
            if (!style) {
              style = doc.createElement('style');
              style.id = id;
              doc.head.appendChild(style);
            }
            style.innerHTML = overrideCss;
          }
          function getReaderRendition() {
            if (typeof rendition !== 'undefined' && rendition) return rendition;
            if (window.rendition) return window.rendition;
            return null;
          }
          function applyEverywhere() {
            installStyle(document);
            var r = getReaderRendition();
            if (r && typeof r.getContents === 'function') {
              r.getContents().forEach(function(contents) {
                installStyle(contents && contents.document);
              });
            }
          }
          window.__chatbookReaderFontFamily = family;
          window.__chatbookReaderFontCss = overrideCss;
          if (typeof window.__chatbookApplyReaderFont === 'function') {
            window.__chatbookApplyReaderFont(family);
          } else {
            window.__chatbookApplyReaderFont = function() {
              applyEverywhere();
            };
            var readerRendition = getReaderRendition();
            if (!window.__chatbookLightFontRenderedHook && readerRendition && typeof readerRendition.on === 'function') {
              window.__chatbookLightFontRenderedHook = true;
              readerRendition.on('rendered', function(section, contents) {
                installStyle(contents && contents.document);
              });
            }
            applyEverywhere();
          }
        } catch (e) {}
      })();
      true;
    `);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, bodyFontKey]);

  useEffect(() => {
    if (!isReady || !readerSettingsLoaded) return;
    changeFontSize(`${fontSizePt}pt`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, readerSettingsLoaded, fontSizePt]);

  // 阶段十四：epub.js自带的目录导航页（章节列表那一页，见上面"首次打开
  // 跳过"那个effect的注释）虽然已经不再是首次打开的默认落脚点了，但书本
  // 身把它当成spine里的一节，用户手动往前翻页还是能翻回去看到——之前是
  // 纯浏览器默认样式（白底+蓝色下划线链接），跟App其余阅读体验完全不搭。
  // rendition.themes（changeTheme）按道理该统一套到所有小节，但这个导航
  // 页表现明显没吃到；没深究epub.js内部为什么这一节例外，直接用已经在用
  // 的injectJavascript机制（跟上面注入字体的方式一样）另外补一层通用
  // 样式、且加!important——不管根因是不是没吃到主题，这层都能兜底盖过去。
  // 依赖里带上themeName：用户切换阅读主题（默认/护眼/夜间）时这里也要
  // 跟着重新注入一份新颜色，不然切主题之后颜色会跟正文不一致。
  useEffect(() => {
    if (!isReady) return;
    const { background, color } = THEMES[themeName].body;
    injectJavascript(`
      (function() {
        try {
          var style = document.createElement('style');
          style.innerHTML =
            'body{background:${background} !important;color:${color} !important;}' +
            'a{color:${uiTheme.accent} !important;text-decoration:none !important;}' +
            'ol,ul{padding-left:1.4em;}' +
            'li{margin-bottom:.6em;line-height:1.6;}' +
            'nav h1,h1{font-size:1.3em;margin-bottom:.8em;}';
          document.head.appendChild(style);
        } catch (e) {}
      })();
      true;
    `);
  }, [isReady, themeName]);

  // 安卓 Chromium 在翻页/滑动过程中偶尔会先生成原生文字选区。把一次
  // 触摸先归类：720ms 内移动超过 10px 就视为翻页并清掉误选；稳定长按
  // 达到门槛后才允许继续拖动选区手柄。iOS 不注入，保持原有行为。
  useEffect(() => {
    if (!isReady || Platform.OS !== 'android') return;
    injectJavascript(`
      (function() {
        function getReaderRendition() {
          if (typeof rendition !== 'undefined' && rendition) return rendition;
          return window.rendition || null;
        }
        function install(doc) {
          if (!doc || doc.__chatbookAndroidSelectionGuard) return;
          doc.__chatbookAndroidSelectionGuard = true;
          var startX = 0, startY = 0, startAt = 0;
          var qualified = false, rejected = false, timer = null, clearUntil = 0;
          function postClear() {
            try {
              var bridge = window.ReactNativeWebView || (window.parent && window.parent.ReactNativeWebView);
              if (bridge && bridge.postMessage) {
                bridge.postMessage(JSON.stringify({ type: 'chatbookClearAccidentalSelection' }));
              }
            } catch (e) {}
          }
          function clearSelection() {
            try {
              var view = doc.defaultView;
              var selected = view && view.getSelection ? view.getSelection() : null;
              if (selected && selected.rangeCount) selected.removeAllRanges();
            } catch (e) {}
            postClear();
          }
          function hasTextSelection() {
            try {
              var view = doc.defaultView;
              var selected = view && view.getSelection ? view.getSelection() : null;
              return !!(selected && selected.rangeCount && String(selected).trim());
            } catch (e) {
              return false;
            }
          }
          function scheduleClear(duration) {
            clearUntil = Date.now() + duration;
            clearSelection();
            setTimeout(clearSelection, 60);
            setTimeout(clearSelection, 180);
            setTimeout(clearSelection, 420);
          }
          doc.addEventListener('touchstart', function(e) {
            clearTimeout(timer);
            var touch = e.changedTouches && e.changedTouches[0];
            if (!touch || (e.touches && e.touches.length !== 1)) {
              rejected = true;
              qualified = false;
              return;
            }
            startX = touch.clientX;
            startY = touch.clientY;
            startAt = Date.now();
            qualified = false;
            rejected = false;
            timer = setTimeout(function() { qualified = !rejected; }, 760);
          }, { passive: true, capture: true });
          doc.addEventListener('touchmove', function(e) {
            if (rejected) return;
            var touch = e.changedTouches && e.changedTouches[0];
            if (!touch) return;
            var dx = Math.abs(touch.clientX - startX);
            var dy = Math.abs(touch.clientY - startY);
            if (!qualified && (dx > 6 || dy > 6)) {
              rejected = true;
              clearTimeout(timer);
              scheduleClear(900);
            } else if (qualified && (dx > 14 || dy > 14) && !hasTextSelection()) {
              rejected = true;
              clearTimeout(timer);
              scheduleClear(900);
            }
          }, { passive: true, capture: true });
          doc.addEventListener('touchend', function() {
            clearTimeout(timer);
            if (rejected || !qualified || Date.now() - startAt < 760) scheduleClear(900);
            qualified = false;
            rejected = false;
          }, { passive: true, capture: true });
          doc.addEventListener('touchcancel', function() {
            clearTimeout(timer);
            qualified = false;
            rejected = true;
            scheduleClear(900);
          }, { passive: true, capture: true });
          doc.addEventListener('selectionchange', function() {
            if (rejected || Date.now() < clearUntil) {
              clearSelection();
            }
          }, true);
        }
        try {
          var readerRendition = getReaderRendition();
          install(document);
          if (readerRendition && typeof readerRendition.getContents === 'function') {
            readerRendition.getContents().forEach(function(contents) {
              install(contents && contents.document);
            });
          }
          if (!window.__chatbookAndroidSelectionRenderedHook && readerRendition && typeof readerRendition.on === 'function') {
            window.__chatbookAndroidSelectionRenderedHook = true;
            readerRendition.on('rendered', function(section, contents) {
              install(contents && contents.document);
            });
          }
        } catch (e) {}
      })();
      true;
    `);
  }, [isReady]);

  // 阶段十四：点击左右边缘翻页——前两版分别用RN的Pressable和
  // react-native-gesture-handler的Gesture.Tap()在WebView上面盖一层透明
  // 覆盖区域，真机反馈两版都会不同程度挡住划线选字（第二版加了iOS原生的
  // cancelsTouchesInView(false)想让WebView也能同时收到触摸，依然没解决，
  // 每行开头一两个字这种靠近覆盖区域的位置始终选不上）。根源是RN原生
  // 视图和WebView内部本来就是两套独立的触摸/手势系统，隔一层原生覆盖物
  // 硬要它们不互相打架，没能做到。
  // 换个完全不同的思路：不在RN这一层做，直接往WebView内部的文档里挂一个
  // 原生的click监听器，点边缘时调rendition.prev()/next()（epub.js原生
  // API，goPrevious/goNext底层实际调的就是这两个）。"点击"和"选中文字"
  // 是浏览器/WebKit自己原生分辨的两种手势——网页里点链接和拖拽选中文字
  // 几十年来一直能正常共存，click事件根本不会在一次文字选择的拖拽过程中
  // 触发，不需要我们在外面额外协调两套系统抢touch。
  useEffect(() => {
    if (!isReady) return;
    injectJavascript(`
      (function() {
        try {
          document.addEventListener('click', function(e) {
            var w = window.innerWidth;
            if (e.clientX < w * 0.22) { rendition.prev(); }
            else if (e.clientX > w * 0.78) { rendition.next(); }
          }, true);
        } catch (e) {}
      })();
      true;
    `);
  }, [isReady]);

  // "跳转到原文位置"从划线复盘详情页过来——如果这本书已经打开过（Reader 还
  // 挂载在书架堆栈里），只传 initialLocation 不会生效，那个属性很多阅读器
  // 组件只在"第一次挂载"时读一次。用 goToLocation 主动跳转才能保证不管书
  // 是不是已经开着，跳转都能生效。jumpNonce 保证哪怕连续两次跳同一个位置，
  // 每次点击都会真正触发一次（不然同样的字符串值不会重新触发 effect）。
  // 加了个短延迟：onReady 触发的那一刻，epub.js 内部默认的 rendition.display()
  // （渲染上次退出的位置/第一页）可能还没真正跑完，这时候立刻再发一次
  // display() 指令，两次调用抢着执行，就是真机反馈"跳转有时候不生效"的
  // 表现——等一小段时间错开，不是根治，是实用的规避办法。
  useEffect(() => {
    if (!(isReady && jumpToCfi)) return;
    const t = setTimeout(() => goToLocation(jumpToCfi), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, jumpToCfi, jumpNonce]);

  // 阶段十四：真机反馈"第一次打开一本从没读过的书，会先经过epub.js自己
  // 生成的目录导航页"（无样式的原始HTML链接列表，截图确认在《孟子》
  // 《道德经》两本不同书上都出现，是所有书首次打开时的通用行为，不是单本
  // 书EPUB文件的问题）。之前的常驻目录按钮只提供了绕开它的入口，没解决
  // "第一次打开就落在这个页面上"本身。这里检测到"没有保存过阅读进度、
  // 也不是从复盘页跳转过来的"（initialLocation和jumpToCfi都没有）这种
  // 真正的首次打开场景，主动跳到目录第一个真实章节——直接复用
  // goToTocItem（跟用户手动点目录条目走的是同一段逻辑，不是另起一套）。
  // 跟上面"跳转到原文位置"那个effect一样加小延迟错开epub.js自己内部的
  // 初始display()，用ref保证只跳一次，不会在后续toc数组引用变化时重复跳。
  useEffect(() => {
    if (!isReady || initialLocation || jumpToCfi) return;
    if (skippedInitialNav.current) return;
    if (!toc || toc.length === 0) return;
    skippedInitialNav.current = true;
    const firstReadable = findFirstReadableTocItem(toc);
    if (!firstReadable?.href) return;
    const t = setTimeout(() => goToTocItem(firstReadable.href), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, toc]);

  function openEpubReadyGate(reason) {
    if (epubReadyGateOpen) return;
    console.log(`[阅读器ready] ${reason}`);
    setEpubReadyGateOpen(true);
  }

  function maybeOpenEpubReadyGateFromLocation(location, section) {
    if (readerMode !== 'epub' || !isReady || epubReadyGateOpen) return;
    const cfi = location?.start?.cfi;
    if (!cfi) return;
    const label = section?.label || section?.title || '';
    const href = location?.start?.href || location?.end?.href || section?.href || '';
    if (!label && !href && !initialLocation && !jumpToCfi) return;
    if (isLikelyEpubNonReadingTarget(label) || isLikelyEpubNonReadingTarget(href)) return;
    openEpubReadyGate('location-ready');
  }

  function handleLocationChange(_total, currentLocation, _progress, currentSection) {
    const cfi = currentLocation?.start?.cfi;
    if (currentSection?.label) setCurrentSectionTitle(currentSection.label.trim());
    maybeOpenEpubReadyGateFromLocation(currentLocation, currentSection);
    if (!readerInteractionReady) return;
    if (!cfi) return;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    // 续二十三访客模式：访客没有账号，阅读进度不做持久化（跟划线一样，
    // 是访客流程草案里"访客数据只存在本地临时状态，不同步"这条产品决策）
    // ——之前这里访客会照常发请求、后端401、控制台打一条警告，不是错误
    // 但也没必要每次翻页都发一个注定失败的请求，直接跳过。
    if (!isLoggedIn()) return;
    progressTimer.current = setTimeout(() => {
      updateProgress(bookId, cfi).catch((e) => console.warn('[进度上报失败]', e.message));
    }, PROGRESS_DEBOUNCE_MS);
  }

  async function handleHighlight(cfiRange, text, fragments = null) {
    if (!readerInteractionReady) return false;
    // 续二十三访客模式：划线本来就是"读的过程"里要按账号持久化的数据
    // （访客划线不做转移，见访客流程草案的产品决策），访客点划线不该
    // 打后端一个必然401的请求再弹一个"HTTP 401 ..."的原始报错——直接
    // 拦在请求之前，弹注册引导。
    if (!requireAuth('ai')) return false;
    try {
      const standardFragments = Array.isArray(fragments)
        ? fragments
            .map((item) => ({
              cfiRange: String(item?.cfiRange || ''),
              text: String(item?.text || '').trim(),
            }))
            .filter((item) => item.cfiRange.startsWith('standard:') && item.text)
        : [];
      if (readerMode === 'standard' && standardFragments.length > 1) {
        const savedItems = await Promise.all(standardFragments.map((item) => (
          saveHighlight(bookId, { cfiLocation: item.cfiRange, highlightedText: item.text })
        )));
        setStandardSavedHighlights((prev) => [
          ...prev,
          ...standardFragments.map((item, index) => ({
            cfiRange: item.cfiRange,
            text: item.text,
            id: savedItems[index]?.id,
          })),
        ]);
        return false;
      }
      const saved = await saveHighlight(bookId, { cfiLocation: cfiRange, highlightedText: text });
      if (readerMode === 'epub' && cfiRange?.startsWith('epubcfi(')) {
        addAnnotation('highlight', cfiRange, { id: saved.id }, { color: '#ffd54f' });
      } else if (readerMode === 'standard' && cfiRange?.startsWith('standard:')) {
        setStandardSavedHighlights((prev) => [...prev, { cfiRange, text }]);
      }
    } catch (e) {
      Alert.alert('划线保存失败', e.message || '请稍后重试');
    }
    return false; // 保留选区高亮，不清除
  }

  function openChat(selectionText = '', cfiRange = '') {
    if (!readerInteractionReady) return;
    // 续二十三访客模式："问AI"是三个约定的注册引导触发点之一——访客点
    // 这个按钮不弹聊天面板，先弹注册引导。
    if (!requireAuth('ai')) return;
    setChatParams({ selection: selectionText, cfiRange });
    chatSheetRef.current?.present();
  }

  // 续二十七：正文背景色(THEMES，EPUB WebView内部)和全局chrome主题
  // (theme.js)语义上是同一件事的两个渲染面——"护眼模式"这个概念只应该
  // 有一份状态，不能正文变护眼色、外面的顶栏/按钮却没跟着变。这里改选
  // 项时两头一起改，'paper'这个内部名字映射到theme.js的'eyecare'
  // （命名不统一是历史遗留：THEMES这个对象阶段十一就有了，theme.js的
  // eyecare是续二十七才加的，两边改名对不上收益不大，就地做一次映射）。
  function selectTheme(next) {
    if (!readerInteractionReady) return;
    setThemeName(next);
    changeTheme(THEMES[next]);
    setThemeMode(THEME_MODE_BY_FAMILY[THEME_FAMILY[next]]);
  }

  function toggleThemePanel() {
    if (!readerInteractionReady) return;
    setShowFontSizePanel(false);
    setShowThemePanel((v) => !v);
  }

  function toggleFontSizePanel() {
    if (!readerInteractionReady) return;
    setShowThemePanel(false);
    setShowFontSizePanel((v) => !v);
  }

  function adjustFontSize(delta) {
    if (!readerInteractionReady) return;
    setFontSizePt((prev) => {
      const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, prev + delta));
      return next;
    });
  }

  function selectBodyFont(key) {
    if (!readerInteractionReady) return;
    if (!BODY_FONT_KEYS.includes(key)) return;
    setBodyFontKey(key);
  }

  function selectReaderMode(mode) {
    if (!readerInteractionReady) return;
    if (!READER_MODE_ORDER.includes(mode)) return;
    setShowToc(false);
    setShowFontSizePanel(false);
    setShowThemePanel(false);
    setReaderMode(mode);
  }

  function selectStandardChapter(index) {
    if (!readerInteractionReady) return;
    setStandardChapterIndex(index);
    setStandardPageIndex(0);
    setShowToc(false);
  }

  function makeStandardCfi(paragraphIndex) {
    const chapter = readingChapters?.[standardChapterIndex];
    return `standard:${chapter?.id || 'unknown'}:${paragraphIndex}`;
  }

  const bodyFont = BODY_FONT_OPTIONS.find((o) => o.key === bodyFontKey) || BODY_FONT_OPTIONS[0];
  const standardFontSize = Math.round(fontSizePt * 1.35);
  const standardLineHeight = Math.round(standardFontSize * STANDARD_READING_LINE_HEIGHT);
  // 预留高度：旧壳沿用 142（顶栏+边距，历史上调出来的）；沉浸式下正文区 = 屏幕高 −
  // 顶部安全区 − 底部信息条(44) − 底部安全区，再减 WebView 页内上下边距(12+8) 和一段安全余量
  // （分页是按字数预算估算的，页内 overflow:hidden，估多了会把最后一行裁掉，所以要留余量）。
  const paginationReserved = immersive
    ? insets.top + READER_INFO_STRIP_HEIGHT + insets.bottom + 20 + 40
    : 142;
  // 章节正文的取法：当前章优先用 state（加载完写进去的），state 还是上一章的旧数据时
  // （翻过章节的那一帧）直接从内存缓存里拿——相邻章节早已预读，这样翻章时分页是同步算出来的，
  // 不会出现"页码已经变了、正文还是旧章"的一帧。上一章/下一章只从内存缓存取，取不到就是 null，
  // 翻页容器那一侧暂时没有页面（预读一完成会自动补上）。
  const standardCacheMode = importedStandard ? 'standard' : 'original';
  const getMemoryChapterPayload = (chapterIndex) => {
    const chapter = readingChapters?.[chapterIndex];
    if (!chapter) return null;
    return STANDARD_CHAPTER_MEMORY_CACHE.get(`${standardCacheMode}:${bookId}:${chapter.id}`) || null;
  };
  const currentChapterIdForPages = readingChapters?.[standardChapterIndex]?.id;
  const currentChapterPayload = (standardChapterText && standardChapterText.chapterId === currentChapterIdForPages)
    ? standardChapterText
    : getMemoryChapterPayload(standardChapterIndex);
  const prevChapterPayload = getMemoryChapterPayload(standardChapterIndex - 1);
  const nextChapterPayload = getMemoryChapterPayload(standardChapterIndex + 1);
  const paginatePayload = (payload) => (payload
    ? paginateStandardBlocks(
      payload.blocks || normalizeStandardBlocks(payload),
      fontSizePt,
      windowSize.width,
      windowSize.height,
      paginationReserved,
    )
    : null);
  const standardPages = useMemo(
    () => paginatePayload(currentChapterPayload) || [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentChapterPayload, fontSizePt, windowSize.width, windowSize.height, paginationReserved],
  );
  // 只在"每一页内容 = 前一章末页 / 后一章首页"需要时才用到：不参与当前章的任何逻辑
  const prevChapterPages = useMemo(
    () => paginatePayload(prevChapterPayload),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prevChapterPayload, fontSizePt, windowSize.width, windowSize.height, paginationReserved],
  );
  const nextChapterPages = useMemo(
    () => paginatePayload(nextChapterPayload),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nextChapterPayload, fontSizePt, windowSize.width, windowSize.height, paginationReserved],
  );
  const standardPage = standardPages[Math.min(standardPageIndex, standardPages.length - 1)] || [];
  // 整本书的阅读进度：(已读章数 + 本章内进度)/总章数，末章末页=100%。后端只有章节粒度，
  // 各章长度不等，所以这是"按章节均分"的估算，不是按字数的精确进度。
  const readingChapterCount = Math.max(1, readingChapters?.length || 1);
  const standardProgress = Math.min(1, Math.max(0,
    (standardChapterIndex + (standardPages.length
      ? (Math.min(standardPageIndex, standardPages.length - 1) + 1) / standardPages.length
      : 0)) / readingChapterCount));
  const standardPercent = Math.round(standardProgress * 100);

  function seekStandardProgress(p) {
    if (!readerInteractionReady) return;
    const target = Math.min(readingChapterCount - 0.0001, Math.max(0, p * readingChapterCount));
    const chapterIndex = Math.floor(target);
    const frac = target - chapterIndex;
    if (chapterIndex === standardChapterIndex && standardPages.length) {
      setStandardPageIndex(Math.round(frac * (standardPages.length - 1)));
      return;
    }
    pendingSeekRef.current = { chapterIndex, frac };
    setStandardChapterIndex(chapterIndex);
    setStandardPageIndex(0);
  }

  // 跳到别的章节后，等那一章的正文和分页都就绪，再落到目标页
  useEffect(() => {
    const pending = pendingSeekRef.current;
    if (!pending || standardChapterIndex !== pending.chapterIndex) return;
    const id = readingChapters?.[pending.chapterIndex]?.id;
    if (!standardChapterText || standardChapterText.chapterId !== id || !standardPages.length) return;
    pendingSeekRef.current = null;
    setStandardPageIndex(Math.round(pending.frac * (standardPages.length - 1)));
  }, [standardChapterIndex, standardChapterText, standardPages, readingChapters]);
  const standardChapterId = readingChapters?.[standardChapterIndex]?.id || '';
  // 安卓 file 方式：当前字体的本地路径；还没准备好时 standardFontPending=true，
  // 先显示加载页（首次一般不到 1 秒，之后有进程内缓存），避免先闪一下系统字体。
  const standardFontUrl = standardFontMode === 'file' ? (standardFontUris[bodyFontKey] || '') : '';
  const standardFontPending = Platform.OS === 'android' && standardFontMode === 'file' && !standardFontUrl;
  // 每一页的 HTML 只在"这一页的内容/样式"变了才重新生成（相邻页不会每次渲染都重算）。
  // key 里带上字体/主题/字体来源：这些一变就整批换新 WebView；字号、划线变化只让同一个
  // WebView 原地换内容（旧内容会留到新内容画好，比先白屏好）。
  // 安卓的翻页容器换主题时不重建页面，而是往现有页面里注入新的底色/字色（见下面 applyTheme 的 effect）：
  // 重建 3 个整屏 WebView 又慢又吃内存，连着切主题时会出现整页空白。所以安卓这里的 key 和
  // html 都不依赖主题（themeDep 固定）；iOS 仍走旧的"换主题=换 key 重建"。
  const themeRef = useRef(themeName);
  themeRef.current = themeName;
  const themeDep = pagerEnabled ? 'static' : themeName;
  const standardStyleSig = `${bodyFontKey}-${themeDep}-${standardFontUrl ? 'file' : (standardFontBase64 ? 'font' : 'fallback')}`;
  const makeStandardPage = useMemo(() => (blocks, chapterId, pageIndex, chapterIdx) => ({
    key: `${chapterId}:${pageIndex}:${standardStyleSig}`,
    // 这一页在整本书里的先后序号：翻页容器按它固定每一页的层级（越靠前层级越高），层级一辈子不变
    order: chapterIdx * 10000 + pageIndex,
    html: buildStandardPageHtml({
      blocks,
      fontFamily: bodyFont.family,
      fontCssFamily: bodyFont.cssFamily,
      fontBase64: standardFontMode === 'inline' ? standardFontBase64 : '',
      fontUrl: standardFontUrl,
      fontWeight: bodyFont.profile.weight || 400,
      fontSize: standardFontSize,
      lineHeight: standardLineHeight,
      theme: THEMES[themeRef.current].body,
      accent: uiTheme.accent,
      highlights: standardSavedHighlights,
      chapterId,
      androidSelectionGuard: Platform.OS === 'android',
      screenTopOffset: immersive ? insets.top : 0,
    }),
  }), [
    standardStyleSig,
    bodyFont,
    standardFontBase64,
    standardFontMode,
    standardFontUrl,
    standardFontSize,
    standardLineHeight,
    themeDep,
    uiTheme.accent,
    standardSavedHighlights,
    immersive,
    insets.top,
  ]);
  // 换主题：把新颜色注入现有页面（新建的页面 html 里本来就是当前主题）
  useEffect(() => {
    if (!pagerEnabled) return;
    standardPagerRef.current?.applyTheme?.(THEMES[themeName].body);
  }, [themeName]);
  const prevChapterId = readingChapters?.[standardChapterIndex - 1]?.id || '';
  const nextChapterId = readingChapters?.[standardChapterIndex + 1]?.id || '';
  const safePageIndex = Math.min(standardPageIndex, Math.max(0, standardPages.length - 1));
  // 三页各自的"源数据"：下面 useMemo 的依赖用它们（数组引用稳定），而不是每次新建的对象
  const curPageBlocks = standardPages[safePageIndex] || null;
  const prevPageBlocks = safePageIndex > 0
    ? standardPages[safePageIndex - 1]
    : (prevChapterPages && prevChapterPages.length ? prevChapterPages[prevChapterPages.length - 1] : null);
  const prevPageRefIndex = safePageIndex > 0 ? safePageIndex - 1 : (prevChapterPages ? prevChapterPages.length - 1 : 0);
  const nextPageBlocks = safePageIndex < standardPages.length - 1
    ? standardPages[safePageIndex + 1]
    : (nextChapterPages && nextChapterPages.length ? nextChapterPages[0] : null);
  const nextPageRefIndex = safePageIndex < standardPages.length - 1 ? safePageIndex + 1 : 0;
  const curPage = useMemo(
    () => (curPageBlocks ? makeStandardPage(curPageBlocks, standardChapterId, safePageIndex, standardChapterIndex) : null),
    [curPageBlocks, makeStandardPage, standardChapterId, safePageIndex, standardChapterIndex],
  );
  const prevPage = useMemo(
    () => (prevPageBlocks ? makeStandardPage(prevPageBlocks, safePageIndex > 0 ? standardChapterId : prevChapterId, prevPageRefIndex, safePageIndex > 0 ? standardChapterIndex : standardChapterIndex - 1) : null),
    [prevPageBlocks, makeStandardPage, standardChapterId, prevChapterId, safePageIndex, prevPageRefIndex, standardChapterIndex],
  );
  const nextPage = useMemo(
    () => (nextPageBlocks ? makeStandardPage(nextPageBlocks, safePageIndex < standardPages.length - 1 ? standardChapterId : nextChapterId, nextPageRefIndex, safePageIndex < standardPages.length - 1 ? standardChapterIndex : standardChapterIndex + 1) : null),
    [nextPageBlocks, makeStandardPage, standardChapterId, nextChapterId, safePageIndex, standardPages.length, nextPageRefIndex, standardChapterIndex],
  );
  const pagerPages = useMemo(
    () => ({ prev: prevPage, cur: curPage, next: nextPage }),
    [prevPage, curPage, nextPage],
  );

  // 预读：当前章排好之后，往后读 3 章、往前读 1 章，放进内存缓存。往后多读几章是因为
  // 有的章只有一页，连翻几下就会用到后面的章。预读一章完成就 tick 一下，让翻页容器补上页面。
  useEffect(() => {
    // 只有启用翻页容器的平台需要预读相邻章节（后 3 章、前 1 章）
    if (!pagerEnabled || readerMode !== 'standard' || !readingChapters?.length) return undefined;
    if (!standardChapterText || standardChapterText.chapterId !== readingChapters[standardChapterIndex]?.id) return undefined;
    let cancelled = false;
    (async () => {
      const offsets = [1, -1, 2, 3];
      for (const offset of offsets) {
        const chapter = readingChapters[standardChapterIndex + offset];
        if (!chapter) continue;
        try {
          await getCachedStandardChapterText(bookId, chapter.id, { includeBlocks: true, standard: standardCacheMode === 'standard' });
          if (cancelled) return;
          setPrefetchTick((t) => t + 1);
        } catch (e) {
          console.warn('[标准阅读缓存] 相邻章节预读失败', e?.message || e);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [readerMode, readingChapters, standardChapterIndex, standardChapterText, bookId, standardCacheMode]);
  const visibleChapterTitle = readerMode === 'standard'
    ? (standardChapterText?.title || readingChapters?.[standardChapterIndex]?.title || bookTitle)
    : (currentSectionTitle || bookTitle);

  useEffect(() => {
    setStandardPageIndex((prev) => Math.min(prev, Math.max(0, standardPages.length - 1)));
  }, [standardPages.length]);

  const standardInteractionReady = readerSettingsLoaded && !standardChapterError && !!standardChapterText && !standardFontPending;
  const epubInteractionReady = readerSettingsLoaded && !!epubSrc && isReady;
  const readerInteractionReady = readerMode === 'standard' ? standardInteractionReady : epubInteractionReady;
  const readerLoadingStageIndex = readerMode === 'standard'
    ? (!readerSettingsLoaded ? 1 : !standardChapterText ? 2 : 3)
    : (!epubSrc ? 0 : !isReady ? 2 : !epubReadyGateOpen ? 3 : 4);
  const readerLoadingLabel = readerMode === 'standard'
    ? (!readerSettingsLoaded ? '正在读取你的阅读设置' : '正在整理正文内容')
    : (!epubSrc ? '正在准备书籍文件' : !isReady ? '正在解析书籍内容' : '正在应用阅读样式');
  const showReaderGateOverlay = readerMode === 'standard'
    ? (!readerInteractionReady && !standardChapterError && !epubError)
    : (!epubSrc && !epubError);
  const readerPanelOpen = showFontSizePanel || showThemePanel;

  useEffect(() => {
    if (!showReaderGateOverlay) {
      setReaderLoadingTick(0);
      return undefined;
    }
    setReaderLoadingTick(0);
    const timer = setInterval(() => setReaderLoadingTick((prev) => prev + 1), 900);
    return () => clearInterval(timer);
  }, [showReaderGateOverlay, readerLoadingStageIndex]);

  useEffect(() => {
    if (readerMode !== 'standard' || !readerInteractionReady) return undefined;
    const chapter = readingChapters?.[standardChapterIndex];
    if (!chapter) return undefined;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    if (!isLoggedIn()) return undefined;
    const cfi = `${STANDARD_PROGRESS_PREFIX}${chapter.id}:${standardPageIndex}`;
    progressTimer.current = setTimeout(() => {
      updateProgress(bookId, cfi).catch((e) => console.warn('[标准阅读进度上报失败]', e.message));
    }, PROGRESS_DEBOUNCE_MS);
    return undefined;
  }, [readerMode, readerInteractionReady, standardChapterIndex, standardPageIndex, readingChapters, bookId]);

  function closeReaderPanels() {
    if (immersive && chromeOpen) {
      setChromeOpen(false);
      return true;
    }
    if (!readerPanelOpen) return false;
    setShowFontSizePanel(false);
    setShowThemePanel(false);
    return true;
  }

  function clearStandardSelection() {
    if (standardSelectionTimerRef.current) {
      clearTimeout(standardSelectionTimerRef.current);
      standardSelectionTimerRef.current = null;
    }
    setSelection(null);
    standardWebViewRef.current?.injectJavaScript?.(`
      window.__standardClearSelection && window.__standardClearSelection();
      true;
    `);
  }

  // 翻页分两步：① 翻页容器把页面滑到位（点边缘=一段动画；手指拖=跟着手走，松手再吸附）；
  // ② 滑到位之后容器回调 commitStandardTurn(dir)，这里才真正改页码/章节。
  // 容器那一侧还没有页面（相邻章节没读进来）、或者 iOS（没有翻页容器）时，
  // 直接调 commitStandardTurn 做"不带动画的跳转"，功能不打折。
  function commitStandardTurn(dir) {
    lastPagerTurnAtRef.current = Date.now();
    if (dir > 0) {
      if (standardPageIndex < standardPages.length - 1) {
        setStandardPageIndex((prev) => Math.min(standardPages.length - 1, prev + 1));
      } else if (standardChapterIndex < (readingChapters?.length || 0) - 1) {
        setStandardChapterIndex((prev) => Math.min((readingChapters?.length || 1) - 1, prev + 1));
        setStandardPageIndex(0);
      }
      return;
    }
    if (standardPageIndex > 0) {
      setStandardPageIndex((prev) => Math.max(0, prev - 1));
    } else if (standardChapterIndex > 0) {
      // 往前翻进上一章：落在上一章的最后一页
      const landing = prevChapterPages && prevChapterPages.length ? prevChapterPages.length - 1 : null;
      if (landing !== null) {
        landingPageRef.current = landing;
        setStandardChapterIndex((prev) => Math.max(0, prev - 1));
        setStandardPageIndex(landing);
      } else {
        // 上一章还没读进来，页数未知：交给"跳章后落到目标页"的老机制，落在末页
        pendingSeekRef.current = { chapterIndex: standardChapterIndex - 1, frac: 1 };
        setStandardChapterIndex((prev) => Math.max(0, prev - 1));
        setStandardPageIndex(0);
      }
    }
  }

  function canTurnStandard(dir) {
    return dir > 0
      ? (standardPageIndex < standardPages.length - 1 || standardChapterIndex < (readingChapters?.length || 0) - 1)
      : (standardPageIndex > 0 || standardChapterIndex > 0);
  }

  function goStandardTurn(dir) {
    if (!readerInteractionReady) return;
    // 注意 iOS 上这个 ref 指向的是 WebView，没有 isBusy/turn，所以都用可选调用
    if (standardPagerRef.current?.isBusy?.()) { queueTurn(dir); return; }
    if (closeReaderPanels()) return;
    clearStandardSelection();
    if (!canTurnStandard(dir)) {
      queuedTurnRef.current = { dir: 0, n: 0 }; // 已经到头了，剩下的排队作废
      return;
    }
    if (!standardPagerRef.current?.turn?.(dir)) commitStandardTurn(dir);
  }

  function goStandardPrev() { goStandardTurn(-1); }

  function goStandardNext() { goStandardTurn(1); }

  // 页码/章节变了 = 上一次翻页已提交：如果动画期间有排队的点击，接着翻
  useEffect(() => {
    const queued = queuedTurnRef.current;
    if (!queued.n) return;
    // 取出一下来翻，剩下的留在队列里，等这一下提交后（本 effect 再次触发）继续
    queuedTurnRef.current = { dir: queued.dir, n: queued.n - 1 };
    if (queued.dir > 0) goStandardNext(); else goStandardPrev();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standardPageIndex, standardChapterIndex]);

  function handleStandardWebViewMessage(event) {
    if (!readerInteractionReady) return;
    let data;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (data?.type === 'standardSelection' && data.text) {
      const text = String(data.text || '').trim().slice(0, 600);
      const cfiRange = String(data.cfiRange || makeStandardCfi(0));
      const fragments = Array.isArray(data.fragments)
        ? data.fragments
            .map((item) => ({
              cfiRange: String(item?.cfiRange || ''),
              text: String(item?.text || '').trim().slice(0, 600),
            }))
            .filter((item) => item.cfiRange.startsWith('standard:') && item.text)
        : null;
      if (!text) return;
      if (standardSelectionTimerRef.current) clearTimeout(standardSelectionTimerRef.current);
      standardSelectionTimerRef.current = setTimeout(() => {
        const r = data.rect && Number.isFinite(data.rect.l) ? data.rect : null;
        const rEnd = data.rectEnd && Number.isFinite(data.rectEnd.l) ? data.rectEnd : r;
        setSelection({ text, cfiRange, fragments, rect: r, rectEnd: rEnd, vw: Number(data.vw) || 0, vh: Number(data.vh) || 0 });
        standardSelectionTimerRef.current = null;
      }, 50);
      return;
    }
    if (data?.type === 'standardBodyTap') {
      // 旧脚本在这里发的是 standardClearSelection；新脚本把"点了哪个区域"一起带上来。
      // 一次点击只做一件事：有选区时这一下只用来取消选区，不顺带切换工具栏
      // （样板 click 处理里同样是 `if (hasSelection()) return;`）。
      const hadSelection = !!selection;
      clearStandardSelection();
      if (!immersive || hadSelection) return;
      if (chromeOpen) setChromeOpen(false);
      else if (data.zone === 'center' && readerInteractionReady) setChromeOpen(true);
      return;
    }
    if (data?.type === 'standardVSwipe') {
      // 正在选字/选区存在期间不识别上下滑（任务卡规则 2）；脚本侧已挡住长按，这里挡选区
      if (!immersive || !readerInteractionReady || selection) return;
      setChromeOpen(data.dir === 'down');
      return;
    }
    if (data?.type === 'standardFontFailed') {
      // 页面里的自检发现 file:// 字体没加载出来（比如某些机型/更新版 WebView 对本地
      // 文件的限制不同）：本次进程内不再尝试 file 方式，降级为只内联当前一个子集字体。
      if (Platform.OS === 'android' && standardFontMode === 'file') {
        console.warn('[标准阅读字体] file:// 加载失败，降级为内联');
        ANDROID_FONT_FILE_MODE_FAILED = true;
        setStandardFontMode('inline');
      }
      return;
    }
    if (data?.type === 'standardSelectionError') {
      return;
    }
    if (data?.type === 'standardClearSelection') {
      clearStandardSelection();
      return;
    }
    if (data?.type === 'standardSwipe') {
      // 翻页容器接管了横向拖动（工具栏没展开时）：脚本的滑动判定是重复触发，丢掉。
      // 只有容器没接管（没启用容器 / 工具栏展开着 / 容器的手势没激活）才按脚本的判定翻页。
      const pagerHandled = pagerEnabled && !chromeOpen
        && (standardPagerRef.current?.isBusy?.() || Date.now() - lastPagerTurnAtRef.current < 900);
      if (pagerHandled) return;
      goStandardTurn(data.dir > 0 ? 1 : -1);
      return;
    }
    if (data?.type === 'standardPrev') {
      goStandardPrev();
      return;
    }
    if (data?.type === 'standardNext') {
      goStandardNext();
    }
  }

  function openListen() {
    // 与旧顶栏里的听书按钮同一套逻辑：把"翻到哪了"换算成 0~1 的比例传给听书页
    const standardFraction = standardPages.length > 1
      ? Math.max(0, Math.min(1, standardPageIndex / standardPages.length))
      : 0;
    navigation.navigate('Listen', {
      bookId, bookTitle, author,
      initialChapterTitle: readingChapters?.[standardChapterIndex]?.title,
      startFraction: standardFraction,
    });
  }

  const activeSelection = selection;
  // 安卓沉浸式且拿到了选区矩形：用贴着选区的浮动小菜单；否则（iOS、EPUB 原版模式、旧页面）仍用底部选字栏
  const floatingSelection = immersive && !!activeSelection && !!activeSelection.rect;

  return (
    <SafeAreaView edges={immersive ? ['left', 'right'] : ['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: THEMES[themeName].body.background }]}>
      {immersive ? <StatusBar hidden animated /> : null}
      {!immersive && (
      <>
      <View style={[styles.header, { backgroundColor: uiTheme.accent, paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: uiTheme.textOnAccent }]}>‹ 书架</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: uiTheme.textOnAccent }]} numberOfLines={1}>{visibleChapterTitle}</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={toggleFontSizePanel}
            style={[styles.headerBtn, !readerInteractionReady && styles.headerBtnDisabled]}
            disabled={!readerInteractionReady}
          >
            <IconTextSize color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowToc(true)}
            style={[styles.headerBtn, !readerInteractionReady && styles.headerBtnDisabled]}
            disabled={!readerInteractionReady}
          >
            <IconList color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              // 真机反馈：点听书永远从这一章最开头开始，不能接着阅读器
              // 翻阅的当前位置继续——查过epub.js内部机制，"精确到具体
              // 哪一段"需要往WebView里注入脚本解析CFI、再靠postMessage
              // 传结果回来，但@epubjs-react-native/core没有对外暴露自定义
              // WebView消息的公开接口，这条路走不通，不改这个库源码做不到
              // 精确匹配。改用已经现成公开的数据做近似估算：epub.js分页
              // 后会给出"当前在这一章第几页/共几页"（displayed.page/total），
              // 换算成一个0~1的比例，传给听书页面，听书页面再按这个比例
              // 换算成"该从章节正文数组的第几段开始"——不是精确到字，是
              // "大致在你翻到的位置附近开始"，比"永远从头开始"好很多。
              const displayed = readerMode === 'standard' ? null : currentLocation?.start?.displayed;
              const standardFraction = standardPages.length > 1
                ? Math.max(0, Math.min(1, standardPageIndex / standardPages.length))
                : 0;
              const startFraction = readerMode === 'standard'
                ? standardFraction
                : (displayed && displayed.total > 1
                  ? Math.max(0, Math.min(1, (displayed.page - 1) / displayed.total))
                  : 0);
              navigation.navigate('Listen', {
                bookId, bookTitle, author,
                initialChapterTitle: readerMode === 'standard'
                  ? readingChapters?.[standardChapterIndex]?.title
                  : currentSectionTitle,
                startFraction,
              });
            }}
            style={[styles.headerBtn, !readerInteractionReady && styles.headerBtnDisabled]}
            disabled={!readerInteractionReady}
          >
            <IconHeadphones color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => openChat()}
            style={[styles.headerBtn, !readerInteractionReady && styles.headerBtnDisabled]}
            disabled={!readerInteractionReady}
          >
            <IconMessageCircle color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={toggleThemePanel}
            style={[styles.headerBtn, !readerInteractionReady && styles.headerBtnDisabled]}
            disabled={!readerInteractionReady}
          >
            <IconBrightness color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
        </View>
      </View>

      {showFontSizePanel && (
        <View style={[styles.controlPanelCol, { backgroundColor: uiTheme.cardBg, borderBottomColor: uiTheme.cardBorder }]}>
          <View style={styles.controlPanelRow}>
            <TouchableOpacity
              style={[styles.fontSizeBtn, { borderRadius: uiTheme.radius, borderColor: uiTheme.cardBorder }]}
              onPress={() => adjustFontSize(-FONT_SIZE_STEP)}
              disabled={fontSizePt <= FONT_SIZE_MIN}
            >
              <Text style={[styles.fontSizeBtnText, { color: uiTheme.text, fontSize: 14 }]}>A-</Text>
            </TouchableOpacity>
            <Text style={[styles.fontSizeValue, { color: uiTheme.textSecondary, fontFamily: MONO_FONT }]}>{fontSizePt}pt</Text>
            <TouchableOpacity
              style={[styles.fontSizeBtn, { borderRadius: uiTheme.radius, borderColor: uiTheme.cardBorder }]}
              onPress={() => adjustFontSize(FONT_SIZE_STEP)}
              disabled={fontSizePt >= FONT_SIZE_MAX}
            >
              <Text style={[styles.fontSizeBtnText, { color: uiTheme.text, fontSize: 20 }]}>A+</Text>
            </TouchableOpacity>
          </View>
          {/* 阶段十九：字体选择器（宋体/黑体/楷体三选一），跟字号调节放
              在同一个面板里——都是排版控制，没必要单独占一个头部图标。 */}
          <View style={styles.controlPanelRow}>
            {BODY_FONT_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[
                  styles.themeSegment,
                  { borderRadius: uiTheme.radius, borderColor: uiTheme.cardBorder },
                  bodyFontKey === opt.key && { backgroundColor: uiTheme.accent, borderColor: uiTheme.accent },
                ]}
                onPress={() => selectBodyFont(opt.key)}
              >
                <Text style={[
                  styles.themeSegmentText,
                  styles.fontPresetText,
                  { fontFamily: opt.previewFamily },
                  opt.key === 'sans' && { fontWeight: '700' },
                  { color: bodyFontKey === opt.key ? uiTheme.textOnAccent : uiTheme.textSecondary },
                ]}>
                  {opt.previewText} {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.fontPreviewRow}>
            {BODY_FONT_OPTIONS.map((opt) => (
              <Text
                key={opt.key}
                style={[
                  styles.fontPreviewText,
                  { color: bodyFontKey === opt.key ? uiTheme.accent : uiTheme.textSecondary, fontFamily: opt.previewFamily },
                  opt.key === 'sans' && { fontWeight: '700' },
                ]}
              >
                {opt.previewText} 子曰学而时习之
              </Text>
            ))}
          </View>
          <View style={styles.controlPanelRow}>
            <TouchableOpacity
              style={[styles.fontDiagBtn, { borderRadius: uiTheme.radius, borderColor: uiTheme.cardBorder }]}
              onPress={requestFontDiagnostics}
            >
              <Text style={[styles.themeSegmentText, { color: uiTheme.textSecondary }]}>字体诊断</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {showThemePanel && (
        <View style={[styles.controlPanel, { backgroundColor: uiTheme.cardBg, borderBottomColor: uiTheme.cardBorder }]}>
          {THEME_ORDER.map((name) => (
            <TouchableOpacity
              key={name}
              style={[
                styles.themeSegment,
                { borderRadius: uiTheme.radius, borderColor: uiTheme.cardBorder },
                themeName === name && { backgroundColor: uiTheme.accent, borderColor: uiTheme.accent },
              ]}
              onPress={() => selectTheme(name)}
            >
              <Text style={[
                styles.themeSegmentText,
                { color: themeName === name ? uiTheme.textOnAccent : uiTheme.textSecondary },
              ]}>
                {THEME_SEGMENT_LABEL[name]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      </>
      )}

      <Modal visible={showToc} animationType="slide" onRequestClose={() => setShowToc(false)}>
        <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.tocSafe, { backgroundColor: uiTheme.bg }]} {...tocPanResponder.panHandlers}>
          <View style={[styles.tocHeader, { borderBottomColor: uiTheme.cardBorder, paddingTop: insets.top + 14 }]}>
            <Text style={[styles.tocHeaderTitle, { color: uiTheme.text }]}>目录</Text>
            <TouchableOpacity
              onPress={() => setShowToc(false)}
              style={[styles.tocCloseBtn, { backgroundColor: uiTheme.accentSoft, borderRadius: uiTheme.radius }]}
            >
              <Text style={[styles.tocCloseBtnText, { color: uiTheme.accent }]}>完成</Text>
            </TouchableOpacity>
          </View>
          {/* 老backlog：目录弹层之前是默认的贴边列表+发丝分隔线，没套用
              阶段十定的"暖纸古风"设计系统——这次改成跟全App其它卡片一样
              的cardBg+cardBorder+4px圆角，条目之间用间距分开而不是分隔线。

              2026-08-09用户反馈：章节应该收紧到最宏观的一级（比如"第1章"），
              点开才展开下面隶属于它的副标题——后端这轮已经改成按book.toc
              自己的树形结构分组（章/节/小节可能有好几层，不是固定两层），
              这里配合改成真正递归的TocNode组件，不管数据有几层都能正确
              展开/收起，不是只写死渲染一层subitems。 */}
          {readerMode === 'standard' ? (
            <FlatList
              data={readingChapters || []}
              keyExtractor={(item, idx) => String(item.id || idx)}
              contentContainerStyle={styles.tocListContent}
              renderItem={({ item, index }) => (
                <TouchableOpacity
                  style={[
                    styles.tocCard,
                    styles.standardTocItem,
                    { backgroundColor: uiTheme.cardBg, borderColor: uiTheme.cardBorder, borderRadius: uiTheme.radius },
                    standardChapterIndex === index && { borderColor: uiTheme.accent },
                  ]}
                  onPress={() => selectStandardChapter(index)}
                >
                  <Text style={[styles.tocItemText, { color: standardChapterIndex === index ? uiTheme.accent : uiTheme.text }]} numberOfLines={2}>
                    {item.title || `第${index + 1}章`}
                  </Text>
                </TouchableOpacity>
              )}
            />
          ) : (
            <FlatList
              data={toc}
              keyExtractor={(item, idx) => item.id || String(idx)}
              contentContainerStyle={styles.tocListContent}
              renderItem={({ item, index }) => (
                <View style={[styles.tocCard, { backgroundColor: uiTheme.cardBg, borderColor: uiTheme.cardBorder, borderRadius: uiTheme.radius }]}>
                  <TocNode
                    item={item}
                    depth={0}
                    pathKey={item.id || String(index)}
                    expandedToc={expandedToc}
                    toggleTocExpanded={toggleTocExpanded}
                    onSelect={(href) => { goToTocItem(href); setShowToc(false); }}
                    theme={uiTheme}
                  />
                </View>
              )}
            />
          )}
        </SafeAreaView>
      </Modal>

      <View style={[styles.readerBody, immersive && { paddingTop: insets.top, paddingBottom: READER_INFO_STRIP_HEIGHT + insets.bottom }]}>
        {readerMode === 'standard' ? (
          <View style={[styles.standardReader, { backgroundColor: THEMES[themeName].body.background }]}>
            {standardChapterError ? (
              <View style={styles.centerBox}>
                <Text style={[styles.errorText, { color: uiTheme.danger }]}>章节加载失败：{standardChapterError}</Text>
              </View>
            ) : !standardChapterText || standardFontPending ? (
              <View style={styles.centerBox}>
                <ReaderLoadingProgress stageIndex={readerLoadingStageIndex} tick={readerLoadingTick} subtitle={readerLoadingLabel} theme={uiTheme} />
              </View>
            ) : (
              <>
                {pagerEnabled ? (
                  <StandardPager
                    ref={standardWebViewRef}
                    pages={pagerPages}
                    // 字体走本地文件时：baseUrl 指到字体所在的缓存目录 + allowFileAccess，
                    // 这是实测能加载 file:// 字体的最小权限组合。mixedContentMode 放开是因为
                    // 页面源换成 file:// 后，书里的 http 图片不能被误拦。
                    baseUrl={standardFontUrl ? FileSystem.cacheDirectory : null}
                    allowFileAccess={!!standardFontUrl}
                    background={THEMES[themeName].body.background}
                    onMessage={handleStandardWebViewMessage}
                    onCommit={commitStandardTurn}
                    // 手指开始拖页面：清掉选区。工具栏展开时不响应拖动（横滑交给页面脚本，
                    // 走"收起工具栏"的老逻辑）。
                    onDragStart={() => { lastPagerTurnAtRef.current = Date.now(); clearStandardSelection(); }}
                    dragEnabled={!chromeOpen && readerInteractionReady}
                    // 长按选字的触发时间：安卓 720ms、苹果 320ms（见页面脚本 longPressMs）；拖页手势要在长按触发之前让位
                    holdMs={Platform.OS === 'ios' ? 280 : 450}
                  />
                ) : (
                  // 没启用翻页容器的平台（STANDARD_PAGER_PLATFORMS 里没有的）：保持旧的"每页一个 WebView"
                  <WebView
                    ref={standardWebViewRef}
                    key={`${standardChapterIndex}-${standardPageIndex}-${bodyFontKey}-${themeName}-${standardFontUrl ? 'file' : (standardFontBase64 ? 'font' : 'fallback')}`}
                    originWhitelist={['*']}
                    source={{ html: curPage ? curPage.html : '' }}
                    style={styles.standardReaderPage}
                    containerStyle={styles.standardReaderPage}
                    onMessage={handleStandardWebViewMessage}
                    showsVerticalScrollIndicator={false}
                    showsHorizontalScrollIndicator={false}
                    scrollEnabled={false}
                    bounces={false}
                  />
                )}
                {/* 选中文字后贴着选区弹出的小菜单（划线 / 问AI），仅安卓沉浸式 */}
                {floatingSelection && readerInteractionReady ? (
                  <SelectionPopup
                    rect={activeSelection.rect}
                    rectEnd={activeSelection.rectEnd}
                    vw={activeSelection.vw}
                    vh={activeSelection.vh}
                    dark={THEME_FAMILY[themeName] === 'dark'}
                    onHighlight={async () => {
                      await handleHighlight(activeSelection.cfiRange, activeSelection.text, activeSelection.fragments);
                      clearStandardSelection();
                    }}
                    onAsk={() => {
                      const { text, cfiRange } = activeSelection;
                      clearStandardSelection();
                      openChat(text, cfiRange);
                    }}
                  />
                ) : null}
              </>
            )}
          </View>
        ) : epubError ? (
          <View style={styles.centerBox}>
            <Text style={[styles.errorText, { color: uiTheme.danger }]}>原版 EPUB 加载失败：{epubError}</Text>
          </View>
        ) : !epubSrc ? (
          <View style={styles.centerBox}>
            <ReaderLoadingProgress stageIndex={readerLoadingStageIndex} tick={readerLoadingTick} subtitle={readerLoadingLabel} theme={uiTheme} />
          </View>
        ) : (
          <View
            pointerEvents={readerInteractionReady ? 'auto' : 'none'}
            style={styles.epubReaderHost}
          >
            <Reader
              src={epubSrc}
              fileSystem={useFileSystem}
              width="100%"
              height="100%"
              defaultTheme={THEMES.light}
              initialLocation={initialLocation || undefined}
              onReady={handleReady}
              onDisplayError={(reason) => setEpubError(String(reason || 'EPUB显示失败'))}
              onLocationChange={handleLocationChange}
              onWebViewMessage={handleReaderWebViewMessage}
              onSelected={(text, cfiRange) => {
                if (!readerInteractionReady) return;
                setSelection({ text, cfiRange });
              }}
              menuItems={[
                {
                  label: '划线',
                  action: (cfiRange, text) => {
                    handleHighlight(cfiRange, text);
                    return false;
                  },
                },
                {
                  label: '问AI',
                  action: (cfiRange, text) => {
                    openChat(text, cfiRange);
                    return false;
                  },
                },
              ]}
              renderLoadingFileComponent={() => (
                <View style={styles.centerBox}>
                  <ActivityIndicator size="large" color={uiTheme.accent} />
                  <Text style={[styles.loadingText, { color: uiTheme.textSecondary }]}>正在下载书本…</Text>
                </View>
              )}
            />
          </View>
        )}
        {readerPanelOpen && (
          <TouchableOpacity
            activeOpacity={1}
            style={styles.readerPanelDismissLayer}
            onPress={closeReaderPanels}
          />
        )}
        {showReaderGateOverlay && (
          <View style={[styles.readerReadyOverlay, { backgroundColor: THEMES[themeName].body.background }]}>
            <ReaderLoadingProgress stageIndex={readerLoadingStageIndex} tick={readerLoadingTick} subtitle={readerLoadingLabel} theme={uiTheme} />
          </View>
        )}
      </View>

      {!!activeSelection && readerInteractionReady && !floatingSelection && (
        <View style={[styles.selectionBar, { backgroundColor: uiTheme.text, borderRadius: uiTheme.radius }, immersive && { bottom: READER_INFO_STRIP_HEIGHT + insets.bottom + 8 }]}>
          <Text style={[styles.selectionBarText, { color: uiTheme.bg }]} numberOfLines={1}>“{activeSelection.text}”</Text>
          <View style={styles.selectionBarActions}>
            <TouchableOpacity
              style={[styles.selectionBtn, { backgroundColor: uiTheme.accent, borderRadius: uiTheme.radius }]}
              onPress={async () => {
                await handleHighlight(activeSelection.cfiRange, activeSelection.text, activeSelection.fragments);
                clearStandardSelection();
              }}
            >
              <Text style={[styles.selectionBtnText, { color: uiTheme.textOnAccent }]}>划线</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectionBtn, { backgroundColor: uiTheme.accent, borderRadius: uiTheme.radius }]}
              onPress={() => {
                const { text, cfiRange } = activeSelection;
                clearStandardSelection();
                openChat(text, cfiRange);
              }}
            >
              <Text style={[styles.selectionBtnText, { color: uiTheme.textOnAccent }]}>问AI</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.selectionCloseBtn}
              onPress={() => {
                clearStandardSelection();
              }}
            >
              <Text style={[styles.selectionCloseBtnText, { color: uiTheme.bg }]}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {immersive ? (
        <ReaderChrome
          open={chromeOpen}
          insets={insets}
          readerTheme={themeName}
          bookTitle={bookTitle}
          chapterTitle={visibleChapterTitle}
          percent={standardPercent}
          progress={standardProgress}
          onSeek={seekStandardProgress}
          fontSize={fontSizePt}
          onFontSize={(v) => { if (readerInteractionReady) setFontSizePt(v); }}
          fonts={BODY_FONT_OPTIONS.map((o) => ({ key: o.key, label: o.label, previewFamily: o.previewFamily }))}
          fontKey={bodyFontKey}
          onFont={selectBodyFont}
          themeFamilies={IMMERSIVE_THEME_FAMILIES}
          onTheme={selectTheme}
          onBack={() => navigation.goBack()}
          onToc={() => { setChromeOpen(false); setShowToc(true); }}
          onListen={() => { setChromeOpen(false); openListen(); }}
          onAsk={() => { setChromeOpen(false); openChat(); }}
          enabled={readerInteractionReady}
        />
      ) : null}
      {immersive && !readerInteractionReady ? (
        // 加载中/出错时正文区不可点，工具栏也调不出来——给一个常驻的返回按钮，别把人困在里面
        <TouchableOpacity
          style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 6, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
          onPress={() => navigation.goBack()}
          accessibilityLabel="返回"
        >
          <Text style={{ fontSize: 28, lineHeight: 30, color: THEMES[themeName].body.color }}>‹</Text>
        </TouchableOpacity>
      ) : null}

      <BottomSheetModal
        ref={chatSheetRef}
        snapPoints={chatSnapPoints}
        index={1}
        enableDynamicSizing={false}
        enablePanDownToClose
        backgroundStyle={{ backgroundColor: uiTheme.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}
        handleIndicatorStyle={{ backgroundColor: uiTheme.cardBorder }}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => (
          <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.25} pressBehavior="close" />
        )}
      >
        <BookChatScreen
          bookId={bookId}
          bookTitle={bookTitle}
          author={author}
          chapterTitle={currentSectionTitle}
          selection={chatParams.selection}
          cfiRange={chatParams.cfiRange}
          onClose={() => chatSheetRef.current?.dismiss()}
        />
      </BottomSheetModal>
    </SafeAreaView>
  );
}

export default function ReaderScreen({ route, navigation }) {
  // initialCfi：从"划线复盘"详情页"跳转到原文"过来时带的目标位置。用来做两件事：
  // 首次打开这本书时当 initialLocation 用（优先于阅读进度，只是这一次跳到这里，
  // 不会覆盖保存的阅读进度）；书已经开着的情况下靠 ReaderInner 里的 goToLocation
  // 主动跳转（initialLocation 那套只在首次挂载时生效）。jumpNonce 每次点击"跳转
  // 到原文位置"都会变，保证哪怕连续两次跳同一个位置也真的会触发。
  const { bookId, initialCfi, jumpNonce } = route.params;
  const theme = useTheme();
  const [ctx, setCtx] = useState(null);
  const [highlights, setHighlights] = useState(null);
  const [epubUri, setEpubUri] = useState(null);
  const [epubError, setEpubError] = useState('');
  const [error, setError] = useState('');
  const [preparation, setPreparation] = useState(null);

  // 安卓真机+模拟器排查过"打开卡死在Opening、RN层无报错"的问题——真根因是
  // @epubjs-react-native/core内嵌进WebView执行的那段标注(annotation)相关JS
  // 用了可选链?.语法，老安卓系统WebView解析不了，整段内联脚本直接解析失败，
  // 无法输出任何报错（修复见patches/@epubjs-react-native+core+*.patch）。
  // 这里改成预下载+读成Base64传给<Reader>，是在排查过程中顺带做的加固：
  // 避免依赖库内部在WebView里对file://路径发起fetch()（Chromium的fetch()
  // 不支持file:协议），让EPUB内容完全走内存解码，不经过WebView网络层。
  // 1号任务：诊断"打开导入书籍加载慢"卡在哪一步——不先优化，先用真实
  // 耗时数据定位瓶颈在下载/Base64编码/epub.js内部解析这几段里的哪一段。
  // 打点会跟这次真机诊断一起用完即删，不是要长期留着的埋点。
  const loadEpub = useCallback(async () => {
    const t0 = Date.now();
    const dir = FileSystem.documentDirectory + 'epub_cache/';
    const localUri = dir + `book_${bookId}_v${EPUB_FILE_CACHE_VERSION}.epub`;
    const info = await FileSystem.getInfoAsync(localUri);
    if (info.exists && !info.size) {
      await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
    }
    let currentInfo = await FileSystem.getInfoAsync(localUri);
    if (!currentInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const result = await FileSystem.downloadAsync(getBookFileUrl(bookId), localUri);
      if (result.status && result.status >= 400) {
        await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
        throw new Error(`EPUB下载失败：HTTP ${result.status}`);
      }
      const dlInfo = await FileSystem.getInfoAsync(localUri);
      if (!dlInfo.exists || !dlInfo.size) {
        await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
        throw new Error('EPUB下载失败：文件为空');
      }
      console.log(`[打开诊断] EPUB下载完成 耗时=${Date.now() - t0}ms 文件大小=${dlInfo.size}bytes`);
      currentInfo = dlInfo;
    } else {
      console.log(`[打开诊断] EPUB本地已缓存 跳过下载 文件大小=${currentInfo.size}bytes`);
    }
    const memoryCacheKey = getEpubMemoryCacheKey(bookId, currentInfo);
    const cachedBase64 = EPUB_BASE64_MEMORY_CACHE.get(memoryCacheKey);
    if (cachedBase64) {
      console.log(`[打开诊断] EPUB Base64内存缓存命中 累计耗时=${Date.now() - t0}ms 编码后字符数=${cachedBase64.length}`);
      return cachedBase64;
    }
    const t1 = Date.now();
    const b64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    EPUB_BASE64_MEMORY_CACHE.set(memoryCacheKey, b64);
    if (EPUB_BASE64_MEMORY_CACHE.size > 3) {
      const oldestKey = EPUB_BASE64_MEMORY_CACHE.keys().next().value;
      EPUB_BASE64_MEMORY_CACHE.delete(oldestKey);
    }
    console.log(`[打开诊断] Base64编码完成 耗时=${Date.now() - t1}ms 编码后字符数=${b64.length}`);
    return b64;
  }, [bookId]);

  const load = useCallback(async () => {
    const tStart = Date.now();
    console.log(`[打开诊断] 开始加载 bookId=${bookId}`);
    try {
      setError('');
      setEpubError('');
      setEpubUri(null);
      // 续二十三访客模式：访客没有账号，getHighlights后端仍然要求登录
      // （划线本来就是账号相关数据），会401。之前这三个请求捆在同一个
      // Promise.all里，getHighlights这一个401会让整个all()连带拒绝，
      // 导致访客翻开任何书都直接报错——书本信息(context)和EPUB文件本身
      // 后端已经对访客放开了，不应该被这个账号相关的子请求拖累。改成
      // 访客直接跳过这次请求，给个空数组（访客本来也没有已保存的划线），
      // 不是"请求失败兜底"，是"压根不该发这个请求"。
      const [c, h] = await Promise.all([
        getBookContext(bookId),
        isLoggedIn() ? getHighlights(bookId) : Promise.resolve([]),
      ]);
      console.log(`[打开诊断] context+highlights就绪 累计耗时=${Date.now() - tStart}ms`);
      // 服务端没有标准章节的旧导入书：不走标准阅读的预下载，后面退回原版 EPUB
      if (IS_STANDARD_ONLY && c.source === 'imported' && c.standard_chapters?.length) {
        await prepareImportedStandardBook(bookId, c.standard_chapters, (done, total) => {
          setPreparation({ done, total });
        });
      }
      setCtx(c);
      setHighlights(h);
    } catch (e) {
      setError(e.message || '加载失败');
    }
  }, [bookId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!ctx) return undefined;
    if (IS_STANDARD_ONLY && ctx.source === 'imported' && ctx.standard_chapters?.length) {
      setEpubError('');
      setEpubUri(null);
      return undefined;
    }
    let cancelled = false;
    setEpubError('');
    setEpubUri(null);
    loadEpub()
      .then((b64) => {
        if (!cancelled) setEpubUri(b64);
      })
      .catch((e) => {
        if (!cancelled) setEpubError(e.message || '书籍文件准备失败');
      });
    return () => { cancelled = true; };
  }, [ctx, loadEpub]);

  if (error) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
        <View style={styles.centerBox}>
          <Text style={[styles.errorText, { color: theme.danger }]}>打开失败：{error}</Text>
          <TouchableOpacity style={[styles.retryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]} onPress={() => navigation.goBack()}>
            <Text style={[styles.retryText, { color: theme.textOnAccent }]}>返回书架</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!ctx || !highlights) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
        <View style={styles.centerBox}>
          <ReaderLoadingProgress
            stageIndex={preparation ? 2 : 0}
            subtitle={preparation
              ? `正在保存正文 ${preparation.done}/${preparation.total} 章`
              : '正在准备书籍正文'}
            percent={preparation ? Math.round(preparation.done / preparation.total * 100) : undefined}
            theme={theme}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <ReaderInner
      bookId={bookId}
      bookTitle={ctx.title}
      author={ctx.author}
      initialLocation={initialCfi || ctx.current_cfi_location}
      jumpToCfi={initialCfi}
      jumpNonce={jumpNonce}
      initialAnnotations={highlights}
      navigation={navigation}
      epubSrc={epubUri}
      epubError={epubError}
      chapters={ctx.chapters}
      standardChapters={ctx.standard_chapters}
      bookSource={ctx.source}
    />
  );
}

function ReaderLoadingProgress({ stageIndex, tick = 0, title = '正在准备阅读体验', subtitle, percent, theme }) {
  const activeIndex = Math.max(0, Math.min(READER_LOADING_STAGES.length - 1, stageIndex));
  const pct = Number.isFinite(percent) ? percent : getReaderLoadingPercent(activeIndex, tick);
  const waitingLonger = tick >= 12 && activeIndex >= 2 && activeIndex < READER_LOADING_STAGES.length - 1;
  return (
    <View style={styles.loadingProgressBox}>
      <Text style={[styles.loadingProgressTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.loadingProgressSubtitle, { color: theme.textSecondary }]}>
        {subtitle || READER_LOADING_STAGES[activeIndex]}
      </Text>
      <View style={[styles.loadingProgressTrack, { backgroundColor: theme.cardBorder }]}>
        <View style={[styles.loadingProgressFill, { width: `${pct}%`, backgroundColor: theme.accent }]} />
      </View>
      <Text style={[styles.loadingProgressPercent, { color: theme.textMuted }]}>{pct}%</Text>
      <View style={styles.loadingStageList}>
        {READER_LOADING_STAGES.map((label, index) => {
          const done = index < activeIndex;
          const active = index === activeIndex;
          return (
            <View key={label} style={styles.loadingStageRow}>
              <View style={[
                styles.loadingStageDot,
                { borderColor: active || done ? theme.accent : theme.cardBorder },
                done && { backgroundColor: theme.accent },
              ]} />
              <Text style={[
                styles.loadingStageText,
                { color: active || done ? theme.textSecondary : theme.textMuted },
                active && { color: theme.text, fontWeight: '700' },
              ]}>
                {label}
              </Text>
            </View>
          );
        })}
      </View>
      {activeIndex >= 2 && (
        <Text style={[styles.loadingProgressHint, { color: theme.textMuted }]}>
          {waitingLonger ? '这本书结构较复杂，仍在继续准备正文' : '首次打开大书会稍慢一些，之后会更快'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
  },
  headerBtn: { padding: 5, minWidth: 32, alignItems: 'center', justifyContent: 'center' },
  headerBtnDisabled: { opacity: 0.35 },
  headerBtnText: { fontSize: 15, fontWeight: '600' },

  readerBody: { flex: 1, position: 'relative' },
  epubReaderHost: { flex: 1 },
  readerHostHidden: { opacity: 0 },
  readerReadyOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    elevation: 40,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  readerPanelDismissLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    elevation: 50,
  },
  standardReader: { flex: 1, position: 'relative' },
  standardReaderPage: { flex: 1, position: 'relative', overflow: 'hidden' },

  controlPanel: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 12, paddingVertical: 10, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  controlPanelCol: {
    gap: 12, paddingVertical: 10, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  controlPanelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  fontSizeBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  fontSizeBtnText: { fontWeight: '700' },
  fontSizeValue: { fontSize: 14, fontWeight: '600', minWidth: 40, textAlign: 'center' },

  themeSegment: { paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1 },
  fontPresetText: { minWidth: 44, textAlign: 'center' },
  fontPreviewRow: { gap: 4, alignItems: 'center' },
  fontPreviewText: { fontSize: 16, lineHeight: 24 },
  fontDiagBtn: { paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1 },
  themeSegmentText: { fontSize: 13, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 13 },
  loadingProgressBox: {
    width: '78%',
    maxWidth: 360,
    alignItems: 'stretch',
    gap: 10,
  },
  loadingProgressTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  loadingProgressSubtitle: { fontSize: 13, textAlign: 'center', marginBottom: 4 },
  loadingProgressTrack: {
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  loadingProgressFill: {
    height: '100%',
    borderRadius: 999,
  },
  loadingProgressPercent: { fontSize: 12, textAlign: 'right' },
  loadingStageList: { gap: 8, marginTop: 4 },
  loadingStageRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loadingStageDot: { width: 9, height: 9, borderRadius: 9, borderWidth: 1.5 },
  loadingStageText: { fontSize: 12.5 },
  loadingProgressHint: { fontSize: 12, textAlign: 'center', marginTop: 4, lineHeight: 18 },
  errorText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { fontWeight: '600' },

  selectionBar: {
    position: 'absolute', left: 12, right: 12, bottom: 24,
    paddingVertical: 10, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    shadowColor: '#000', shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 2 }, shadowRadius: 6, elevation: 4,
    // 翻页容器上线后，这条在真机模拟器上被页面盖住了：显式给一个高层级
    zIndex: 60,
  },
  selectionBarText: { flex: 1, fontSize: 13, marginRight: 10 },
  selectionBarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectionBtn: { paddingHorizontal: 12, paddingVertical: 7 },
  selectionBtnText: { fontSize: 13, fontWeight: '600' },
  selectionCloseBtn: { paddingHorizontal: 6, paddingVertical: 7 },
  selectionCloseBtnText: { fontSize: 15 },

  tocSafe: { flex: 1 },
  tocHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tocHeaderTitle: { fontSize: 17, fontWeight: '700' },
  tocCloseBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  tocCloseBtnText: { fontSize: 14, fontWeight: '600' },
  tocListContent: { padding: 12, gap: 10 },
  tocCard: { borderWidth: 1, overflow: 'hidden' },
  standardTocItem: { paddingHorizontal: 16, paddingVertical: 14 },
  tocRow: { flexDirection: 'row', alignItems: 'center' },
  tocRowMain: { flex: 1, paddingRight: 8, paddingVertical: 14 },
  tocItemText: { fontSize: 15 },
  tocChevronBtn: { paddingHorizontal: 16, paddingVertical: 14 },
  tocChevron: { fontSize: 13 },
  tocSubItemText: { fontSize: 14 },
});
