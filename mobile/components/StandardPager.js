// 标准阅读器的"翻页容器"：让翻页从"画面直接跳变"变成"整页平滑滑过去"。
//
// 之前的做法：整个阅读区只有一个 WebView，翻页 = 换 key = 销毁旧的、新建一个新的、再重新排版，
// 中间要 250~450ms，而且期间画面是直接切换、没有过渡。
//
// 现在的做法：上一页 / 当前页 / 下一页 三个 WebView 常驻，翻页之前下一页早已排好版、画好了；
// 翻页时只做一件事——用原生动画把"轨道"横向平移一页宽（原生驱动，不占 JS 线程，
// 所以正文很长也不会卡）。动画结束后再通知外面"页码 +1"，同时这三个 WebView 换角色：
//   旧的"当前页"变"上一页"，旧的"下一页"变"当前页"（是同一个 WebView 实例，不重建），
//   再在另一端补一个新的"下一页"。
//
// 坐标约定：每页有一个"序号"(ordinal)，屏幕位置 = 序号×页宽 + 轨道位移。轨道位移只增不减地
// 累积（-pos×页宽），所以换角色时每个 WebView 的屏幕位置一像素都不用改，不会闪。
// 只有"跳转"（改字号/换主题/拖进度条/点目录）才会换掉整批页面，那时不做动画。
import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

// 翻页动画时长：手感上"轻快但看得清"的区间是 220~300ms。用 easeOutQuint 类的曲线：
// 起步快、收尾慢，像真的纸张被推过去后自然停稳。
const TURN_MS = 260;
const TURN_EASING = Easing.bezier(0.22, 1, 0.36, 1);
// 目标页还没加载完时，最多等多久再开始动画（防止滑进来一张空白页）
const LOAD_WAIT_MAX_MS = 500;

const PagerPage = React.memo(function PagerPage({
  page, ordinal, width, track, isCurrent, isCurrentRef, onMessageRef, webRef, onLoaded,
  baseUrl, allowFileAccess, background,
}) {
  // 屏幕位置 = 轨道位移 + 序号×页宽。序号变了才重新生成这个"加法节点"。
  const translateX = useMemo(
    () => Animated.add(track, new Animated.Value(ordinal * width)),
    [track, ordinal, width],
  );
  // source 对象必须稳定：每次渲染都是新对象的话 WebView 会当作"换了页面"重新加载
  const source = useMemo(
    () => (baseUrl ? { html: page.html, baseUrl } : { html: page.html }),
    [page.html, baseUrl],
  );
  const handleMessage = useCallback((event) => {
    // 只有"当前页"的消息算数：隐藏的上一页/下一页（比如它们自己的自检消息）一律忽略，
    // 否则会出现"点的是这页，翻页/工具栏却被别的页触发"。
    if (!isCurrentRef.current || isCurrentRef.current !== page.key) return;
    onMessageRef.current && onMessageRef.current(event);
  }, [isCurrentRef, onMessageRef, page.key]);
  return (
    <Animated.View
      // 不是"当前页"的两页不接收触摸，避免动画中途被误点
      pointerEvents={isCurrent ? 'auto' : 'none'}
      style={[styles.slot, { width, backgroundColor: background, transform: [{ translateX }] }]}
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
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  const track = useRef(new Animated.Value(0)).current;
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

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive) reduceMotionRef.current = !!v; }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => { reduceMotionRef.current = !!v; });
    return () => { alive = false; sub && sub.remove && sub.remove(); };
  }, []);

  // 页宽变了（旋转/折叠屏）：轨道位移要跟着按新页宽重算，否则整体错位
  useEffect(() => {
    if (width) track.setValue(-posRef.current * width);
  }, [width, track]);

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
        // 等待期间如果整批页面被换掉了（改了字号等），这次翻页作废
        if (!pagesRef.current.cur || pagesRef.current.cur.key !== startKey) {
          busyRef.current = false;
          return;
        }
        const fromPos = posRef.current;
        const toPos = fromPos + dir;
        const finish = () => {
          // 动画期间整批页面被换掉：不提交页码，只把轨道摆回原位
          if (!pagesRef.current.cur || pagesRef.current.cur.key !== startKey) {
            track.setValue(-fromPos * width);
            busyRef.current = false;
            return;
          }
          posRef.current = toPos;
          setPos(toPos);
          onCommit && onCommit();
          busyRef.current = false;
        };
        if (reduceMotionRef.current) {
          track.setValue(-toPos * width);
          finish();
          return;
        }
        Animated.timing(track, {
          toValue: -toPos * width,
          duration: TURN_MS,
          easing: TURN_EASING,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (!finished) {
            track.setValue(-fromPos * width);
            busyRef.current = false;
            return;
          }
          finish();
        });
      };
      if (loadedRef.current.has(target.key)) {
        run();
      } else {
        // 目标页还没加载完：等它加载完再滑（最多等 LOAD_WAIT_MAX_MS），
        // 不然会滑进来一张空白页，比直接慢半拍还难受
        const waiters = loadWaitersRef.current.get(target.key) || [];
        waiters.push(run);
        loadWaitersRef.current.set(target.key, waiters);
        setTimeout(run, LOAD_WAIT_MAX_MS);
      }
      return true;
    },
  }), [track, width]);

  const list = [
    pages.prev ? { role: 'prev', page: pages.prev, slot: -1 } : null,
    pages.cur ? { role: 'cur', page: pages.cur, slot: 0 } : null,
    pages.next ? { role: 'next', page: pages.next, slot: 1 } : null,
  ].filter(Boolean);

  return (
    <View
      style={[styles.host, { backgroundColor: background }]}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
    >
      {width > 0 ? list.map(({ role, page, slot }) => (
        <PagerPage
          key={page.key}
          page={page}
          ordinal={pos + slot}
          width={width}
          track={track}
          isCurrent={role === 'cur'}
          isCurrentRef={isCurrentRef}
          onMessageRef={onMessageRef}
          webRef={webRef}
          onLoaded={handleLoaded}
          baseUrl={baseUrl}
          allowFileAccess={allowFileAccess}
          background={background}
        />
      )) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  host: { flex: 1, position: 'relative' },
  slot: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  web: { flex: 1, position: 'relative', overflow: 'hidden' },
});

export default StandardPager;
