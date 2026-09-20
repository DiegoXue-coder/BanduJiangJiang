// 标准阅读器的"翻页容器"：让翻页从"画面直接跳变"变成"整页平滑滑过去"。
//
// 之前的做法：整个阅读区只有一个 WebView，翻页 = 换 key = 销毁旧的、新建一个新的、再重新排版，
// 中间要 250~450ms，而且期间画面是直接切换、没有过渡。
//
// 现在的做法：上一页 / 当前页 / 下一页 三个 WebView 常驻，翻页之前下一页早已排好版、画好了；
// 翻页时只做一件事——用原生动画把最上面那一页横向滑走（或滑入），动画跑在原生线程，
// 不占 JS 线程，正文再长也不会卡。动画结束后再通知外面"页码 ±1"，三个 WebView 换角色
// （旧的"下一页"变"当前页"，是同一个 WebView 实例，不重建），再在另一端补一个新的相邻页。
//
// 【为什么三页是"叠"在一起而不是"排成一行"】第一版把上一页/下一页排在屏幕左右两侧之外，
// 模拟器录屏抽帧发现：滑进来的页第一帧只有上半截有字、下半截空白，隔几帧才补全——
// 因为整个跑在屏幕外的 WebView 不会被绘制，Chromium 没给它画完整。所以改成：
// 三页始终都在屏幕范围内、上下叠放（当前页在最上面、下一页在中间、上一页在最下面），
// 被压在下面的页照常被绘制，滑动时"露"出来的页一定是已经画好的。
//   往后翻：当前页向左滑走，露出压在下面的下一页；
//   往前翻：上一页从左边滑进来，盖住当前页。（此时上一页临时提到最上层）
// 这是"覆盖式"翻页（iOS 图书 / 微信读书的一种常见样式），不是"整体平移式"。
//
// 【为什么常驻 2 个而不是 3 个】三个整屏 WebView 同时叠在屏幕里，模拟器（2.5GB 内存）上改字号
// 让它们同时重载后，Chromium 报 "tile memory limits exceeded, some content may not draw"，
// 整页空白。所以：静止时只常驻"当前页 + 下一页"（往后翻是最常见的动作，做到最丝滑）；
// 往前翻时才临时把"上一页"挂到当前页下面、等它画好、再滑进来，同时把"下一页"卸掉——
// 任何时刻整屏 WebView 不超过 2 个。往前翻因此会有一小段"等上一页画好"的时间
// （和改造前的翻页耗时相当），换来内存安全；往后翻则是即点即滑。
import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

// 翻页动画时长：手感上"轻快但看得清"的区间是 220~300ms。用 easeOutQuint 类的曲线：
// 起步快、收尾慢，像真的纸张被推过去后自然停稳。
const TURN_MS = 260;
const TURN_EASING = Easing.bezier(0.22, 1, 0.36, 1);
// 目标页还没加载完时，最多等多久再开始动画（防止滑出来一张空白页）
const LOAD_WAIT_MAX_MS = 700;
// 上一页加载完之后再等这么久才开始滑，给 Chromium 一点时间把画面真正绘出来
const PREV_RASTER_MS = 120;

const PagerPage = React.memo(function PagerPage({
  page, width, translateX, zIndex, isCurrent, isCurrentRef, onMessageRef, webRef, onLoaded,
  baseUrl, allowFileAccess, background,
}) {
  // source 对象必须稳定：每次渲染都是新对象的话 WebView 会当作"换了页面"重新加载
  const source = useMemo(
    () => (baseUrl ? { html: page.html, baseUrl } : { html: page.html }),
    [page.html, baseUrl],
  );
  const handleMessage = useCallback((event) => {
    // 只有"当前页"的消息算数：被压在下面的上一页/下一页（比如它们自己的自检消息）一律忽略，
    // 否则会出现"点的是这页，翻页/工具栏却被别的页触发"。
    if (!isCurrentRef.current || isCurrentRef.current !== page.key) return;
    onMessageRef.current && onMessageRef.current(event);
  }, [isCurrentRef, onMessageRef, page.key]);
  return (
    <Animated.View
      // 不是"当前页"的页不接收触摸，避免动画中途被误点
      pointerEvents={isCurrent ? 'auto' : 'none'}
      style={[styles.slot, { width, zIndex, backgroundColor: background, transform: [{ translateX }] }]}
    >
      <WebView
        ref={isCurrent ? webRef : undefined}
        originWhitelist={['*']}
        source={source}
        allowFileAccess={allowFileAccess}
        mixedContentMode={allowFileAccess ? 'always' : undefined}
        style={[styles.web, { backgroundColor: background }]}
        containerStyle={[styles.web, { backgroundColor: background }]}
        onMessage={handleMessage}
        onLoadEnd={() => onLoaded(page.key)}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
      />
    </Animated.View>
  );
});

// pages: { prev, cur, next }，每个是 { key, html } 或 null（书的首页没有上一页 / 末页没有下一页 /
//        相邻章节还没读进来）。key 要能唯一标识"这一页的内容+样式"，同一页不变。
const StandardPager = forwardRef(function StandardPager({
  pages, baseUrl, allowFileAccess, background, onMessage,
}, ref) {
  const [width, setWidth] = useState(0);
  // 正在进行的翻页：null（静止）| { dir: 1 | -1 }。静止时三页都是静态的 translateX=0，
  // 只有动画期间才把最上面那页绑到动画值上；动画结束的那一刻，这个 state 和页码在同一次
  // 渲染里一起更新，所以"角色互换"和"回到静止样式"是原子的，不会闪。
  const [turning, setTurning] = useState(null);
  // 往前翻的准备阶段：上一页已挂在当前页下面正在加载/绘制，画好之前不开始动画
  const [prepPrev, setPrepPrev] = useState(false);
  const progress = useRef(new Animated.Value(0)).current; // 0 → 1
  const busyRef = useRef(false);
  const webRef = useRef(null);
  const onMessageRef = useRef(null);
  onMessageRef.current = onMessage;
  const loadedRef = useRef(new Set());
  const loadWaitersRef = useRef(new Map());
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const isCurrentRef = useRef(null);
  isCurrentRef.current = pages.cur ? pages.cur.key : null;
  const reduceMotionRef = useRef(false);
  const pendingRef = useRef(null); // { dir, startKey, onCommit }

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive) reduceMotionRef.current = !!v; }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => { reduceMotionRef.current = !!v; });
    return () => { alive = false; sub && sub.remove && sub.remove(); };
  }, []);

  const handleLoaded = useCallback((key) => {
    loadedRef.current.add(key);
    const waiters = loadWaitersRef.current.get(key);
    if (waiters) {
      loadWaitersRef.current.delete(key);
      waiters.forEach((fn) => fn());
    }
  }, []);

  // 已卸载页面的"已加载"记录顺手清掉，避免集合无限增长
  useEffect(() => {
    const alive = new Set([pages.prev?.key, pages.cur?.key, pages.next?.key].filter(Boolean));
    loadedRef.current.forEach((k) => { if (!alive.has(k)) loadedRef.current.delete(k); });
  }, [pages.prev?.key, pages.cur?.key, pages.next?.key]);

  // turning 一变成非空（样式已绑到动画值上）就开跑
  useEffect(() => {
    if (!turning || !pendingRef.current) return undefined;
    const { startKey, onCommit } = pendingRef.current;
    const done = (commit) => {
      pendingRef.current = null;
      if (commit) {
        // 同一次批处理里：回到静止样式 + 外面把页码改掉
        setTurning(null);
        setPrepPrev(false);
        onCommit && onCommit();
      } else {
        setTurning(null);
        setPrepPrev(false);
      }
      busyRef.current = false;
    };
    // 等待期间/动画期间整批页面被换掉了（改了字号等），这次翻页作废，不提交页码
    const stillValid = () => pagesRef.current.cur && pagesRef.current.cur.key === startKey;
    if (reduceMotionRef.current) {
      done(stillValid());
      return undefined;
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: TURN_MS,
      easing: TURN_EASING,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => done(finished && stillValid()));
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turning]);

  useImperativeHandle(ref, () => ({
    isBusy: () => busyRef.current,
    // 给外面清选区用：只对"当前页"注入脚本
    injectJavaScript: (js) => webRef.current && webRef.current.injectJavaScript && webRef.current.injectJavaScript(js),
    // 翻一页：dir = +1（下一页）/ -1（上一页）。对面没有页面（还没加载）返回 false，
    // 由外面退回"不带动画的直接跳转"。动画结束后回调 onCommit，让外面把页码真正 ±1。
    turn: (dir, onCommit) => {
      const target = dir > 0 ? pagesRef.current.next : pagesRef.current.prev;
      const startKey = pagesRef.current.cur ? pagesRef.current.cur.key : null;
      if (!target || !startKey || !width || busyRef.current) return false;
      busyRef.current = true;
      let started = false;
      const run = () => {
        if (started) return;
        started = true;
        if (!pagesRef.current.cur || pagesRef.current.cur.key !== startKey) {
          setPrepPrev(false);
          busyRef.current = false;
          return;
        }
        progress.setValue(0);
        pendingRef.current = { startKey, onCommit };
        setTurning({ dir });
      };
      const waitLoaded = (afterMs) => {
        if (loadedRef.current.has(target.key)) {
          setTimeout(run, afterMs);
        } else {
          // 目标页还没加载完：等它加载完再滑（最多等 LOAD_WAIT_MAX_MS），
          // 不然会滑出来一张空白页，比直接慢半拍还难受
          const waiters = loadWaitersRef.current.get(target.key) || [];
          waiters.push(() => setTimeout(run, afterMs));
          loadWaitersRef.current.set(target.key, waiters);
          setTimeout(run, LOAD_WAIT_MAX_MS + afterMs);
        }
      };
      if (dir > 0) {
        // 下一页一直常驻，通常已画好，直接滑
        if (loadedRef.current.has(target.key)) run(); else waitLoaded(0);
      } else {
        // 上一页没有常驻：先挂上（压在当前页下面），等它加载完 + 留一小段时间让它绘制，再滑
        loadedRef.current.delete(target.key);
        setPrepPrev(true);
        waitLoaded(PREV_RASTER_MS);
      }
      return true;
    },
  }), [progress, width]);

  // 每一页当前的位置与层级
  const dir = turning ? turning.dir : 0;
  const curX = useMemo(
    () => progress.interpolate({ inputRange: [0, 1], outputRange: [0, -width] }),
    [progress, width],
  );
  const prevInX = useMemo(
    () => progress.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }),
    [progress, width],
  );
  const styleFor = (role) => {
    if (role === 'cur') return { translateX: dir === 1 ? curX : 0, zIndex: 3 };
    if (role === 'next') return { translateX: 0, zIndex: 2 };
    // 上一页（只在往前翻期间才挂载）：准备阶段压在最底层；开滑后提到最上层、从左边滑进来
    return { translateX: dir === -1 ? prevInX : 0, zIndex: dir === -1 ? 4 : 1 };
  };

  // 挂载哪几页：平时 当前+下一页；往前翻期间 上一页+当前（下一页先卸掉，保证同时最多 2 个）
  const backMode = prepPrev || dir === -1;
  const list = (backMode
    ? [
      pages.prev ? { role: 'prev', page: pages.prev } : null,
      pages.cur ? { role: 'cur', page: pages.cur } : null,
    ]
    : [
      pages.cur ? { role: 'cur', page: pages.cur } : null,
      pages.next ? { role: 'next', page: pages.next } : null,
    ]).filter(Boolean);

  return (
    <View
      style={[styles.host, { backgroundColor: background }]}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
    >
      {width > 0 ? list.map(({ role, page }) => {
        const st = styleFor(role);
        return (
          <PagerPage
            key={page.key}
            page={page}
            width={width}
            translateX={st.translateX}
            zIndex={st.zIndex}
            isCurrent={role === 'cur'}
            isCurrentRef={isCurrentRef}
            onMessageRef={onMessageRef}
            webRef={webRef}
            onLoaded={handleLoaded}
            baseUrl={baseUrl}
            allowFileAccess={allowFileAccess}
            background={background}
          />
        );
      }) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  host: { flex: 1, position: 'relative' },
  slot: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  web: { flex: 1, position: 'relative', overflow: 'hidden' },
});

export default StandardPager;
