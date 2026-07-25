import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
  Modal, FlatList, PanResponder,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Reader, useReader } from '@epubjs-react-native/core';
import { useFileSystem } from '@epubjs-react-native/expo-file-system';
import { BottomSheetModal, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { IconList, IconMessageCircle, IconBrightness, IconTextSize } from '@tabler/icons-react-native';
import {
  getBookContext, getBookFileUrl, getHighlights, saveHighlight, updateProgress,
} from '../lib/api';
import { useTheme } from '../theme';
import BookChatScreen from './BookChatScreen';

// 三套主题：亮色 / 暖纸色（护眼） / 深色，对应范围声明里确认的阅读体验要求
const THEMES = {
  light: { body: { background: '#ffffff', color: '#1a1a2e' } },
  paper: { body: { background: '#f4ecd8', color: '#5b4636' } },
  dark:  { body: { background: '#1a1a2e', color: '#dcdce6' } },
};
const THEME_ORDER = ['light', 'paper', 'dark'];
// 阶段十一：颜色/主题从"点一下循环切换"改成"三档横向切换控件"，标签跟着改
const THEME_SEGMENT_LABEL = { light: '默认', paper: '护眼模式', dark: '晚间阅读' };

// 字号调节：pt为单位，对应 epub.js rendition.themes.fontSize() 接受的CSS尺寸。
// 16pt是常见的默认阅读字号（比epub.js库自己的12pt默认值大，更适合国学爱好者
// 目标用户群体），12/28是给的合理上下限，避免调到读不出字或严重溢出。
const FONT_SIZE_DEFAULT = 16;
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 28;
const FONT_SIZE_STEP = 2;

// 进度上报节流：翻页很频繁，没必要每次都请求后端
const PROGRESS_DEBOUNCE_MS = 2000;

function ReaderInner({
  bookId, bookTitle, author, initialLocation, initialAnnotations, navigation,
  jumpToCfi, jumpNonce,
}) {
  const { addAnnotation, changeTheme, changeFontSize, toc, goToLocation, injectJavascript } = useReader();

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
    setChatParams({ selection: selectionText, cfiRange });
    chatSheetRef.current?.present();
  }

  function selectTheme(next) {
    setThemeName(next);
    changeTheme(THEMES[next]);
  }

  function toggleThemePanel() {
    setShowFontSizePanel(false);
    setShowThemePanel((v) => !v);
  }

  function toggleFontSizePanel() {
    setShowThemePanel(false);
    setShowFontSizePanel((v) => !v);
  }

  function adjustFontSize(delta) {
    setFontSizePt((prev) => {
      const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, prev + delta));
      changeFontSize(`${next}pt`);
      return next;
    });
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: THEMES[themeName].body.background }]}>
      <View style={[styles.header, { backgroundColor: uiTheme.accent, paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: uiTheme.textOnAccent }]}>‹ 书架</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: uiTheme.textOnAccent }]} numberOfLines={1}>{bookTitle}</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity onPress={toggleFontSizePanel} style={styles.headerBtn}>
            <IconTextSize color={uiTheme.textOnAccent} size={22} stroke={1.75} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowToc(true)} style={styles.headerBtn}>
            <IconList color={uiTheme.textOnAccent} size={22} stroke={1.75} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => openChat()} style={styles.headerBtn}>
            <IconMessageCircle color={uiTheme.textOnAccent} size={22} stroke={1.75} />
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleThemePanel} style={styles.headerBtn}>
            <IconBrightness color={uiTheme.textOnAccent} size={22} stroke={1.75} />
          </TouchableOpacity>
        </View>
      </View>

      {showFontSizePanel && (
        <View style={[styles.controlPanel, { backgroundColor: uiTheme.cardBg, borderBottomColor: uiTheme.cardBorder }]}>
          <TouchableOpacity
            style={[styles.fontSizeBtn, { borderRadius: uiTheme.radius, borderColor: uiTheme.cardBorder }]}
            onPress={() => adjustFontSize(-FONT_SIZE_STEP)}
            disabled={fontSizePt <= FONT_SIZE_MIN}
          >
            <Text style={[styles.fontSizeBtnText, { color: uiTheme.text, fontSize: 14 }]}>A-</Text>
          </TouchableOpacity>
          <Text style={[styles.fontSizeValue, { color: uiTheme.textSecondary }]}>{fontSizePt}pt</Text>
          <TouchableOpacity
            style={[styles.fontSizeBtn, { borderRadius: uiTheme.radius, borderColor: uiTheme.cardBorder }]}
            onPress={() => adjustFontSize(FONT_SIZE_STEP)}
            disabled={fontSizePt >= FONT_SIZE_MAX}
          >
            <Text style={[styles.fontSizeBtnText, { color: uiTheme.text, fontSize: 20 }]}>A+</Text>
          </TouchableOpacity>
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

      <Modal visible={showToc} animationType="slide" onRequestClose={() => setShowToc(false)}>
        <SafeAreaView style={[styles.tocSafe, { backgroundColor: uiTheme.bg }]} {...tocPanResponder.panHandlers}>
          <View style={[styles.tocHeader, { borderBottomColor: uiTheme.cardBorder }]}>
            <Text style={[styles.tocHeaderTitle, { color: uiTheme.text }]}>目录</Text>
            <TouchableOpacity onPress={() => setShowToc(false)} style={styles.tocCloseBtn}>
              <Text style={[styles.tocCloseBtnText, { color: uiTheme.accent }]}>完成</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={toc}
            keyExtractor={(item, idx) => item.id || String(idx)}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.tocItem, { borderBottomColor: uiTheme.cardBorder }]}
                onPress={() => {
                  goToTocItem(item.href);
                  setShowToc(false);
                }}
              >
                <Text style={[styles.tocItemText, { color: uiTheme.text }]}>{item.label?.trim()}</Text>
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
            <ActivityIndicator size="large" color={uiTheme.accent} />
            <Text style={[styles.loadingText, { color: uiTheme.textSecondary }]}>正在下载书本…</Text>
          </View>
        )}
      />

      {!!selection && (
        <View style={[styles.selectionBar, { backgroundColor: uiTheme.text, borderRadius: uiTheme.radius }]}>
          <Text style={[styles.selectionBarText, { color: uiTheme.bg }]} numberOfLines={1}>“{selection.text}”</Text>
          <View style={styles.selectionBarActions}>
            <TouchableOpacity
              style={[styles.selectionBtn, { backgroundColor: uiTheme.accent, borderRadius: uiTheme.radius }]}
              onPress={async () => {
                await handleHighlight(selection.cfiRange, selection.text);
                setSelection(null);
              }}
            >
              <Text style={[styles.selectionBtnText, { color: uiTheme.textOnAccent }]}>划线</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selectionBtn, { backgroundColor: uiTheme.accent, borderRadius: uiTheme.radius }]}
              onPress={() => {
                const { text, cfiRange } = selection;
                setSelection(null);
                openChat(text, cfiRange);
              }}
            >
              <Text style={[styles.selectionBtnText, { color: uiTheme.textOnAccent }]}>问AI</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectionCloseBtn} onPress={() => setSelection(null)}>
              <Text style={[styles.selectionCloseBtnText, { color: uiTheme.bg }]}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

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
          <ActivityIndicator size="large" color={theme.accent} />
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
  safe: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
  },
  headerBtn: { padding: 5, minWidth: 32, alignItems: 'center', justifyContent: 'center' },
  headerBtnText: { fontSize: 15, fontWeight: '600' },

  controlPanel: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 12, paddingVertical: 10, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fontSizeBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  fontSizeBtnText: { fontWeight: '700' },
  fontSizeValue: { fontSize: 14, fontWeight: '600', minWidth: 40, textAlign: 'center' },

  themeSegment: { paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1 },
  themeSegmentText: { fontSize: 13, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 13 },
  errorText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { fontWeight: '600' },

  selectionBar: {
    position: 'absolute', left: 12, right: 12, bottom: 24,
    paddingVertical: 10, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    shadowColor: '#000', shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 2 }, shadowRadius: 6, elevation: 4,
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
  tocCloseBtn: { padding: 4 },
  tocCloseBtnText: { fontSize: 15, fontWeight: '600' },
  tocItem: {
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tocItemText: { fontSize: 15 },
});
