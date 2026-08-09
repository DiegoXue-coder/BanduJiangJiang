import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert,
  Modal, FlatList, PanResponder,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Reader, useReader } from '@epubjs-react-native/core';
import { useFileSystem } from '@epubjs-react-native/expo-file-system';
import { BottomSheetModal, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { IconList, IconMessageCircle, IconBrightness, IconTextSize, IconHeadphones } from '@tabler/icons-react-native';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import {
  getBookContext, getBookFileUrl, getHighlights, saveHighlight, updateProgress,
} from '../lib/api';
import { useTheme } from '../theme';
import { FONT_ASSETS, FONTS } from '../fonts';
import BookChatScreen from './BookChatScreen';

// 阶段十一：epub正文（书本原文内容）换成思源宋体——这部分渲染在
// react-native-webview内部，不是普通RN Text，普通expo-font的useFonts()
// 对它不生效，需要单独往WebView里注入@font-face引用字体文件的本地路径。
// 这部分是这次字体改造里唯一没法在任何预览环境验证的部分（epub渲染本身
// 在这个项目的沙盒预览里一直不稳定，是这个会话里反复记录过的已知限制），
// 需要真机确认实际效果，若加载失败WebView会静默回退到默认字体，不会白屏。
const EPUB_SERIF_FONT_FAMILY = 'SourceHanSerifSC';

// 2026-08-06排版反馈：决策层用真实截图做before/after对比后确认，行高从
// 默认1.5调到1.75，三档主题（亮色/护眼/夜间）都要统一生效，不是只改一档。
const READING_LINE_HEIGHT = '1.75';

// 三套主题：亮色 / 暖纸色（护眼） / 深色，对应范围声明里确认的阅读体验要求
const THEMES = {
  light: { body: { background: '#ffffff', color: '#1a1a2e', 'line-height': READING_LINE_HEIGHT } },
  paper: { body: { background: '#f4ecd8', color: '#5b4636', 'line-height': READING_LINE_HEIGHT } },
  dark:  { body: { background: '#1a1a2e', color: '#dcdce6', 'line-height': READING_LINE_HEIGHT } },
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
  jumpToCfi, jumpNonce, epubSrc,
}) {
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
  // 长按原生菜单（menuItems）在拖动选区手柄调整范围后不会重新弹出——这是
  // react-native-webview 自身的已知限制，不是我们代码能修的。改用这个悬浮条
  // 兜底：只要 epub.js 报了新的选区（onSelected，拖动调整后也会正常触发），
  // 就显示"划线/问AI"按钮，不依赖那个容易失效的原生菜单。
  const [selection, setSelection] = useState(null); // { text, cfiRange }
  const progressTimer = useRef(null);
  const annotationsRestored = useRef(false);
  const skippedInitialNav = useRef(false);

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
    setIsReady(true);
    if (annotationsRestored.current) return;
    annotationsRestored.current = true;
    for (const h of initialAnnotations) {
      if (!h.cfi_location || !h.cfi_location.startsWith('epubcfi(')) continue;
      addAnnotation('highlight', h.cfi_location, { id: h.id }, { color: '#ffd54f' });
    }
  }

  // 正文换思源宋体：往WebView文档头部插一段@font-face引用字体文件的本地
  // 资源地址，再用changeFontFamily把它设成正文字体。字体文件是expo静态
  // 资源，Asset.fromModule().uri开发模式下是Metro的本地HTTP地址、生产
  // 包里是打包后的本地路径，两种情况WebView都能按URL正常发起请求加载。
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    Asset.fromModule(FONT_ASSETS[FONTS.serifRegular]).downloadAsync().then((asset) => {
      if (cancelled || !asset.localUri && !asset.uri) return;
      const fontUrl = asset.localUri || asset.uri;
      injectJavascript(`
        (function() {
          try {
            var style = document.createElement('style');
            style.innerHTML = '@font-face { font-family: "${EPUB_SERIF_FONT_FAMILY}"; src: url("${fontUrl}"); font-weight: normal; }';
            document.head.appendChild(style);
          } catch (e) {}
        })();
        true;
      `);
      changeFontFamily(EPUB_SERIF_FONT_FAMILY);
    }).catch(() => {}); // 加载失败就静默保留默认字体，不影响阅读
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

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
    const t = setTimeout(() => goToTocItem(toc[0].href), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, toc]);

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
            <IconTextSize color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowToc(true)} style={styles.headerBtn}>
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
              const displayed = currentLocation?.start?.displayed;
              const startFraction = displayed && displayed.total > 1
                ? Math.max(0, Math.min(1, (displayed.page - 1) / displayed.total))
                : 0;
              navigation.navigate('Listen', {
                bookId, bookTitle, author,
                initialChapterTitle: currentSectionTitle,
                startFraction,
              });
            }}
            style={styles.headerBtn}
          >
            <IconHeadphones color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => openChat()} style={styles.headerBtn}>
            <IconMessageCircle color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleThemePanel} style={styles.headerBtn}>
            <IconBrightness color={uiTheme.textOnAccent} size={22} strokeWidth={1.75} />
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
        </SafeAreaView>
      </Modal>

      <View style={styles.readerBody}>
        <Reader
          src={epubSrc}
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
      </View>

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
  const [epubUri, setEpubUri] = useState(null);
  const [error, setError] = useState('');

  // 安卓真机+模拟器排查过"打开卡死在Opening、RN层无报错"的问题——真根因是
  // @epubjs-react-native/core内嵌进WebView执行的那段标注(annotation)相关JS
  // 用了可选链?.语法，老安卓系统WebView解析不了，整段内联脚本直接解析失败，
  // 无法输出任何报错（修复见patches/@epubjs-react-native+core+*.patch）。
  // 这里改成预下载+读成Base64传给<Reader>，是在排查过程中顺带做的加固：
  // 避免依赖库内部在WebView里对file://路径发起fetch()（Chromium的fetch()
  // 不支持file:协议），让EPUB内容完全走内存解码，不经过WebView网络层。
  const loadEpub = useCallback(async () => {
    const dir = FileSystem.documentDirectory + 'epub_cache/';
    const localUri = dir + `book_${bookId}.epub`;
    const info = await FileSystem.getInfoAsync(localUri);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      await FileSystem.downloadAsync(getBookFileUrl(bookId), localUri);
    }
    return FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
  }, [bookId]);

  const load = useCallback(async () => {
    try {
      const [c, h, uri] = await Promise.all([getBookContext(bookId), getHighlights(bookId), loadEpub()]);
      setCtx(c);
      setHighlights(h);
      setEpubUri(uri);
    } catch (e) {
      setError(e.message || '加载失败');
    }
  }, [bookId, loadEpub]);

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

  if (!ctx || !highlights || !epubUri) {
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
      epubSrc={epubUri}
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

  readerBody: { flex: 1, position: 'relative' },

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
  tocCloseBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  tocCloseBtnText: { fontSize: 14, fontWeight: '600' },
  tocListContent: { padding: 12, gap: 10 },
  tocCard: { borderWidth: 1, overflow: 'hidden' },
  tocRow: { flexDirection: 'row', alignItems: 'center' },
  tocRowMain: { flex: 1, paddingRight: 8, paddingVertical: 14 },
  tocItemText: { fontSize: 15 },
  tocChevronBtn: { paddingHorizontal: 16, paddingVertical: 14 },
  tocChevron: { fontSize: 13 },
  tocSubItemText: { fontSize: 14 },
});
