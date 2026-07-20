import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator, Alert,
  Modal, FlatList,
} from 'react-native';
import { Reader, useReader } from '@epubjs-react-native/core';
import { useFileSystem } from '@epubjs-react-native/expo-file-system';
import {
  getBookContext, getBookFileUrl, getHighlights, saveHighlight, updateProgress,
} from '../lib/api';

const BLUE = '#4f8ef7';

// 三套主题：亮色 / 暖纸色（护眼） / 深色，对应范围声明里确认的阅读体验要求
const THEMES = {
  light: { body: { background: '#ffffff', color: '#1a1a2e' } },
  paper: { body: { background: '#f4ecd8', color: '#5b4636' } },
  dark:  { body: { background: '#1a1a2e', color: '#dcdce6' } },
};
const THEME_ORDER = ['light', 'paper', 'dark'];
const THEME_LABEL = { light: '☀️', paper: '📜', dark: '🌙' };

// 进度上报节流：翻页很频繁，没必要每次都请求后端
const PROGRESS_DEBOUNCE_MS = 2000;

function ReaderInner({
  bookId, bookTitle, author, initialLocation, initialAnnotations, navigation,
  jumpToCfi, jumpNonce,
}) {
  const { addAnnotation, changeTheme, toc, goToLocation, injectJavascript } = useReader();

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
  const [themeName, setThemeName] = useState('light');
  const [currentSectionTitle, setCurrentSectionTitle] = useState('');
  const [isReady, setIsReady] = useState(false);
  // 章节目录：epub.js 自动生成的导航页只有第一次打开书时会经过，选了某一章
  // 之后就没有入口再回去挑别的章节——加一个常驻的目录按钮，不依赖那个只会
  // 出现一次的自动导航页
  const [showToc, setShowToc] = useState(false);
  // 长按原生菜单（menuItems）在拖动选区手柄调整范围后不会重新弹出——这是
  // react-native-webview 自身的已知限制，不是我们代码能修的。改用这个悬浮条
  // 兜底：只要 epub.js 报了新的选区（onSelected，拖动调整后也会正常触发），
  // 就显示"划线/问AI"按钮，不依赖那个容易失效的原生菜单。
  const [selection, setSelection] = useState(null); // { text, cfiRange }
  const progressTimer = useRef(null);
  const annotationsRestored = useRef(false);

  // initialAnnotations 要等 Reader 的 onReady 触发（book 真正渲染完成）才能加，
  // 提前调用 addAnnotation 会静默失效，所以不能放进 mount 时的 effect 里。
  function handleReady() {
    setIsReady(true);
    if (annotationsRestored.current) return;
    annotationsRestored.current = true;
    for (const h of initialAnnotations) {
      addAnnotation('highlight', h.cfi_location, { id: h.id }, { color: '#ffd54f' });
    }
  }

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

  function handleLocationChange(_total, currentLocation, _progress, currentSection) {
    const cfi = currentLocation?.start?.cfi;
    if (currentSection?.label) setCurrentSectionTitle(currentSection.label.trim());
    if (!cfi) return;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => {
      updateProgress(bookId, cfi).catch((e) => console.warn('[进度上报失败]', e.message));
    }, PROGRESS_DEBOUNCE_MS);
  }

  async function handleHighlight(cfiRange, text) {
    try {
      const saved = await saveHighlight(bookId, { cfiLocation: cfiRange, highlightedText: text });
      addAnnotation('highlight', cfiRange, { id: saved.id }, { color: '#ffd54f' });
    } catch (e) {
      Alert.alert('划线保存失败', e.message || '请稍后重试');
    }
    return false; // 保留选区高亮，不清除
  }

  function openChat(selectionText = '', cfiRange = '') {
    navigation.navigate('BookChat', {
      bookId, bookTitle, author, chapterTitle: currentSectionTitle,
      selection: selectionText, cfiRange,
    });
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeName) + 1) % THEME_ORDER.length];
    setThemeName(next);
    changeTheme(THEMES[next]);
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: THEMES[themeName].body.background }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>‹ 书架</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{bookTitle}</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity onPress={() => setShowToc(true)} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>📑</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => openChat()} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>💬</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={cycleTheme} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>{THEME_LABEL[themeName]}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal visible={showToc} animationType="slide" onRequestClose={() => setShowToc(false)}>
        <SafeAreaView style={styles.tocSafe}>
          <View style={styles.tocHeader}>
            <Text style={styles.tocHeaderTitle}>目录</Text>
            <TouchableOpacity onPress={() => setShowToc(false)} style={styles.tocCloseBtn}>
              <Text style={styles.tocCloseBtnText}>完成</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={toc}
            keyExtractor={(item, idx) => item.id || String(idx)}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.tocItem}
                onPress={() => {
                  goToTocItem(item.href);
                  setShowToc(false);
                }}
              >
                <Text style={styles.tocItemText}>{item.label?.trim()}</Text>
              </TouchableOpacity>
            )}
          />
        </SafeAreaView>
      </Modal>

      <Reader
        src={getBookFileUrl(bookId)}
        fileSystem={useFileSystem}
        width="100%"
        height="100%"
        defaultTheme={THEMES.light}
        initialLocation={initialLocation || undefined}
        onReady={handleReady}
        onDisplayError={(reason) => Alert.alert('加载失败', String(reason))}
        onLocationChange={handleLocationChange}
        onSelected={(text, cfiRange) => setSelection({ text, cfiRange })}
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
            <ActivityIndicator size="large" color={BLUE} />
            <Text style={styles.loadingText}>正在下载书本…</Text>
          </View>
        )}
      />

      {!!selection && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionBarText} numberOfLines={1}>“{selection.text}”</Text>
          <View style={styles.selectionBarActions}>
            <TouchableOpacity
              style={styles.selectionBtn}
              onPress={async () => {
                await handleHighlight(selection.cfiRange, selection.text);
                setSelection(null);
              }}
            >
              <Text style={styles.selectionBtnText}>划线</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.selectionBtn}
              onPress={() => {
                const { text, cfiRange } = selection;
                setSelection(null);
                openChat(text, cfiRange);
              }}
            >
              <Text style={styles.selectionBtnText}>问AI</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectionCloseBtn} onPress={() => setSelection(null)}>
              <Text style={styles.selectionCloseBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
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
  const [ctx, setCtx] = useState(null);
  const [highlights, setHighlights] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([getBookContext(bookId), getHighlights(bookId)]);
      setCtx(c);
      setHighlights(h);
    } catch (e) {
      setError(e.message || '加载失败');
    }
  }, [bookId]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerBox}>
          <Text style={styles.errorText}>打开失败：{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.retryText}>返回书架</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!ctx || !highlights) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={BLUE} />
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
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: BLUE,
  },
  headerBtn: { padding: 6, minWidth: 36 },
  headerBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '700' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: '#8a95b0', fontSize: 13 },
  errorText: { color: '#f7564f', fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: {
    marginTop: 16, paddingHorizontal: 20, paddingVertical: 10,
    backgroundColor: BLUE, borderRadius: 10,
  },
  retryText: { color: '#fff', fontWeight: '600' },

  selectionBar: {
    position: 'absolute', left: 12, right: 12, bottom: 24,
    backgroundColor: '#1a1a2eee', borderRadius: 14,
    paddingVertical: 10, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    shadowColor: '#000', shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 2 }, shadowRadius: 6, elevation: 4,
  },
  selectionBarText: { flex: 1, color: '#dcdce6', fontSize: 13, marginRight: 10 },
  selectionBarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectionBtn: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
    backgroundColor: BLUE,
  },
  selectionBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  selectionCloseBtn: { paddingHorizontal: 6, paddingVertical: 7 },
  selectionCloseBtnText: { color: '#8a95b0', fontSize: 15 },

  tocSafe: { flex: 1, backgroundColor: '#fff' },
  tocHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dde3f0',
  },
  tocHeaderTitle: { fontSize: 17, fontWeight: '700', color: '#1a1a2e' },
  tocCloseBtn: { padding: 4 },
  tocCloseBtnText: { color: BLUE, fontSize: 15, fontWeight: '600' },
  tocItem: {
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#f0f2f7',
  },
  tocItemText: { fontSize: 15, color: '#1a1a2e' },
});
