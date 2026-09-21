// 标准阅读器的"翻页容器"：整页滑动翻页，而且页面跟着手指走。
//
// ── 历史 ──────────────────────────────────────────────────────────────────────
// 改造前：一页一个 WebView，翻页=销毁旧的、新建一个、重新排版（250~450ms），画面直接跳变。
// 第一版（点一下放一段固定动画）：当前页/下一页常驻，翻页时用原生动画把当前页滑走 260ms。
//   遗留两个问题：① 动画是"写死的"，不跟手；② 往前翻时上一页没常驻，要现挂现等约 0.3s。
// 现在这版：手指按住页面横向拖，页面就跟着手指走（挪到哪跟到哪，挪开一半就走一半，挪回来就回来），
//   松手时按"拖了多远/甩得多快"决定翻过去还是弹回来；点边缘翻页仍然是一段动画。
//   上一页/当前页/下一页三个 WebView 常驻，往前翻也是即点即滑。
//
// ── 怎么做到不卡 ─────────────────────────────────────────────────────────────
// 页面位置由 Reanimated 的"共享值"驱动，手势回调和动画都跑在原生 UI 线程，
// 手指每动一下，位置直接在 UI 线程更新，不经过 JS 线程（JS 线程忙于排版也不影响跟手）。
//
// ── 页面怎么摆 ───────────────────────────────────────────────────────────────
// 三页始终叠在屏幕范围内（当前页在最上面）——屏幕外的 WebView 不会被绘制（实测滑进来时下半截空白），
// 所以不能把邻页排到屏幕外等着：
//   往后翻（手指向左拖）：当前页向左滑走，露出压在下面的下一页；
//   往前翻（手指向右拖）：**上一页从左边滑进来，盖在当前页上面**，当前页自己不动。
//     （第一版是"当前页向右滑走、露出下面不动的上一页"，用户反馈看不出是在翻回去——
//      翻回去应该是"把上一页拉回来"，所以改成上一页作为被拖动的那一页。）
// 静止时上一页压在最底层（保证它一直被绘制过）；往前翻期间临时把它提到最上层（backMode）。
// 每个页面实例有自己的位移共享值（不是按"当前/上一页/下一页"角色共用一个）：
// 翻完之后各页角色互换时，每个实例的位置一像素都不用改，不会闪。
//
// ── 内存 ────────────────────────────────────────────────────────────────────
// 三个整屏 WebView 同时叠着，模拟器（2.5GB）上多个页面同时重载会让 Chromium 报
// "tile memory limits exceeded, some content may not draw"，整页空白。所以：
// ① 先加载当前页，它画好之后才挂下一页，下一页画好之后才挂上一页（错开）；
// ② 改字号/字体这类"整批页面换内容"的变更，邻页比当前页晚 350/700ms 才重载；
// ③ 换主题不重建页面，直接往现有页面注入新颜色（见 applyTheme）。
import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing, makeMutable, runOnJS, useAnimatedStyle, useSharedValue, withTiming,
} from 'react-native-reanimated';
import { WebView } from 'react-native-webview';

const TURN_MS = 260; // 点边缘翻页的动画时长
const LOAD_WAIT_MAX_MS = 700; // 目标页还没加载完时，点边缘翻页最多等多久
// 按住不动超过这个时间就当作"长按选字"，手势让给页面自己处理（页面里长按选字是 720ms，取个更早的值）
const HOLD_MS = 450;
const NEIGHBOR_RELOAD_DELAY = { next: 350, prev: 700 };
const Z = { prev: 1, next: 2, cur: 3 };

const PagerPage = React.memo(function PagerPage({
  page, role, width, tx, backMode, isCurrentRef, onMessageRef, registerWeb, onLoaded,
  baseUrl, allowFileAccess, background,
}) {
  // 往前翻期间上一页要盖在当前页上面（层级 4），平时压在最底层
  const zIndex = role === 'prev' && backMode ? 4 : Z[role];
  // 位置：只由自己的共享值决定（UI 线程更新）
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const setWebRef = useCallback((instance) => registerWeb(page.key, instance), [registerWeb, page.key]);
  // 邻页在"整批换内容"时错开重载：当前页立刻换，下一页晚 350ms，上一页晚 700ms
  const [html, setHtml] = useState(page.html);
  useEffect(() => {
    if (page.html === html) return undefined;
    const delay = NEIGHBOR_RELOAD_DELAY[role] || 0;
    if (!delay) { setHtml(page.html); return undefined; }
    const t = setTimeout(() => setHtml(page.html), delay);
    return () => clearTimeout(t);
  }, [page.html, role, html]);
  // source 对象必须稳定：每次渲染都是新对象的话 WebView 会当作"换了页面"重新加载
  const source = useMemo(
    () => (baseUrl ? { html, baseUrl } : { html }),
    [html, baseUrl],
  );
  const handleMessage = useCallback((event) => {
    // 只有"当前页"的消息算数：压在下面的邻页（比如它们自己的字体自检消息）一律忽略
    if (!isCurrentRef.current || isCurrentRef.current !== page.key) return;
    onMessageRef.current && onMessageRef.current(event);
  }, [isCurrentRef, onMessageRef, page.key]);
  return (
    <Animated.View
      // 只有当前页接收触摸；邻页压在下面，不能被误点
      pointerEvents={role === 'cur' ? 'auto' : 'none'}
      style={[styles.slot, { width, zIndex, backgroundColor: background }, animatedStyle]}
    >
      <WebView
        ref={setWebRef}
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
//        相邻章节还没读进来）。key 要能唯一标识"这一页的位置+字体"，同一页不变。
// onCommit(dir)：翻页动画结束（页面已经滑到位）后调用，外面据此把页码 ±1。
// onDragStart：手指开始拖页面时调用（外面用来清掉选区）。
// dragEnabled：false 时不响应拖动（比如工具栏展开着），触摸原样交给页面里的脚本。
const StandardPager = forwardRef(function StandardPager({
  pages, baseUrl, allowFileAccess, background, onMessage, onCommit, onDragStart, dragEnabled = true,
}, ref) {
  const [width, setWidth] = useState(0);
  const [, setLoadTick] = useState(0); // 有页面加载完就 +1，让"能不能挂邻页/能不能拖"重新计算
  const [prevForce, setPrevForce] = useState(false);
  // 往前翻期间为 true：上一页提到最上层。backSV 是同一份状态的 UI 线程副本（手势回调里读写）
  const [backMode, setBackMode] = useState(false);
  const backSV = useSharedValue(false);

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const onMessageRef = useRef(null);
  onMessageRef.current = onMessage;
  const onCommitRef = useRef(null);
  onCommitRef.current = onCommit;
  const onDragStartRef = useRef(null);
  onDragStartRef.current = onDragStart;
  const isCurrentRef = useRef(null);
  isCurrentRef.current = pages.cur ? pages.cur.key : null;

  const busyRef = useRef(false); // JS 侧：正在拖/正在动画/提交后等待角色互换
  const busySV = useSharedValue(false); // UI 侧同一份状态（手势回调里读）
  const loadedRef = useRef(new Set());
  const loadWaitersRef = useRef(new Map());
  const reduceMotionRef = useRef(false);
  const mountedKeysRef = useRef(new Set());
  const webMapRef = useRef(new Map());
  const txMapRef = useRef(new Map());
  const themeRef = useRef(null);
  const releaseTimerRef = useRef(null);

  const getTx = (key) => {
    let sv = txMapRef.current.get(key);
    if (!sv) { sv = makeMutable(0); txMapRef.current.set(key, sv); }
    return sv;
  };
  const registerWeb = useCallback((key, instance) => {
    if (instance) webMapRef.current.set(key, instance); else webMapRef.current.delete(key);
  }, []);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (alive) reduceMotionRef.current = !!v; }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => { reduceMotionRef.current = !!v; });
    return () => { alive = false; sub && sub.remove && sub.remove(); };
  }, []);

  const handleLoaded = useCallback((key) => {
    loadedRef.current.add(key);
    // 页面刚加载好：如果用户在它加载期间换过主题，补注入一次
    if (themeRef.current) {
      const w = webMapRef.current.get(key);
      const t = themeRef.current;
      w && w.injectJavaScript && w.injectJavaScript(`(function(){var d=document,b=d.body;if(!b)return;d.documentElement.style.background='${t.background}';b.style.background='${t.background}';b.style.color='${t.color}';})();true;`);
    }
    const waiters = loadWaitersRef.current.get(key);
    if (waiters) {
      loadWaitersRef.current.delete(key);
      waiters.forEach((fn) => fn());
    }
    setLoadTick((n) => n + 1);
  }, []);

  // ── 哪些页挂载 ──
  // 先当前页；当前页加载完才挂下一页；下一页加载完（或等了 1.2s）才挂上一页。已经挂着的不会被卸掉。
  const cur = pages.cur;
  const curLoaded = !!cur && loadedRef.current.has(cur.key);
  const nextLoaded = !!pages.next && loadedRef.current.has(pages.next.key);
  const has = (p) => !!p && mountedKeysRef.current.has(p.key);
  const showNext = !!pages.next && (has(pages.next) || curLoaded);
  const showPrev = !!pages.prev && (has(pages.prev) || (curLoaded && (!pages.next || nextLoaded || prevForce)));
  useEffect(() => {
    setPrevForce(false);
    if (!cur) return undefined;
    const t = setTimeout(() => setPrevForce(true), 1200);
    return () => clearTimeout(t);
  }, [cur && cur.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // 手势里要用的"能不能翻"（UI 线程读，用共享值）：对面页面已挂载并且加载完
  const hasNextSV = useSharedValue(false);
  const hasPrevSV = useSharedValue(false);
  const canNext = showNext && nextLoaded;
  const canPrev = showPrev && !!pages.prev && loadedRef.current.has(pages.prev.key);
  useEffect(() => { hasNextSV.value = canNext; hasPrevSV.value = canPrev; }, [canNext, canPrev, hasNextSV, hasPrevSV]);

  // ── 翻完之后（当前页 key 变了）：角色已互换，收尾 ──
  const curKey = cur ? cur.key : null;
  useEffect(() => {
    // 已卸载页面的记录顺手清掉
    const alive = new Set([pages.prev?.key, pages.cur?.key, pages.next?.key].filter(Boolean));
    loadedRef.current.forEach((k) => { if (!alive.has(k)) loadedRef.current.delete(k); });
    txMapRef.current.forEach((sv, k) => { if (!alive.has(k)) txMapRef.current.delete(k); });
    // 所有页位移归零：刚滑走的旧当前页现在是"上一页/下一页"，压在新当前页下面，归零看不出来；
    // 新当前页原本就压在下面、位移是 0。归零发生在角色互换之后，所以不会闪。
    txMapRef.current.forEach((sv) => { sv.value = 0; });
    busyRef.current = false;
    busySV.value = false;
    backSV.value = false;
    setBackMode(false);
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }
  }, [curKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 退出 backMode（翻完 / 松手弹回）：上一页已经回到最底层，位移归零让它重新压在当前页下面
  useEffect(() => {
    if (!backMode) txMapRef.current.forEach((sv) => { sv.value = 0; });
  }, [backMode]);
  const listKeys = [showPrev && pages.prev, cur, showNext && pages.next].filter(Boolean).map((p) => p.key).join('|');
  useEffect(() => {
    mountedKeysRef.current = new Set(listKeys ? listKeys.split('|') : []);
  }, [listKeys]);

  // ── 翻页动画结束（不管是点边缘还是松手）：通知外面页码 ±1 ──
  const finishJS = useCallback((dir) => {
    onCommitRef.current && onCommitRef.current(dir);
    // 兜底：万一外面没让当前页 key 变（比如翻页被拒绝），别让"忙"状态卡住
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      releaseTimerRef.current = null;
      busyRef.current = false;
      busySV.value = false;
      backSV.value = false;
      setBackMode(false);
      txMapRef.current.forEach((sv) => { sv.value = 0; });
    }, 600);
  }, [busySV, backSV]);
  const cancelJS = useCallback(() => {
    busyRef.current = false;
    setBackMode(false);
  }, []);
  const setBackJS = useCallback((on) => { setBackMode(on); }, []);
  const dragStartJS = useCallback(() => {
    busyRef.current = true;
    onDragStartRef.current && onDragStartRef.current();
  }, []);

  // ── 手势：横向拖动跟手 ──
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const downAt = useSharedValue(0);
  const baseDx = useSharedValue(0);
  // 自己算的手指速度（dp/秒）：手势库在"手动激活"模式下给的 velocityX 不可靠（实测一甩就是 0）
  const velX = useSharedValue(0);
  const lastDx = useSharedValue(0);
  const lastT = useSharedValue(0);
  const decided = useSharedValue(0); // 0 还没定 / 1 正在拖 / 2 不是横拖（放弃）
  const curTx = cur ? getTx(cur.key) : null;
  const prevTx = pages.prev ? getTx(pages.prev.key) : null;
  const dragX = useSharedValue(0); // 手指当前带来的位移（<0 往后翻，>0 往前翻），松手判定用
  const gesture = useMemo(() => {
    if (!curTx || !width) return Gesture.Pan().enabled(false);
    return Gesture.Pan()
      .manualActivation(true)
      .enabled(dragEnabled)
      .onTouchesDown((e) => {
        'worklet';
        const t = e.allTouches[0];
        if (!t) return;
        startX.value = t.absoluteX;
        startY.value = t.absoluteY;
        downAt.value = Date.now();
        decided.value = busySV.value ? 2 : 0;
        velX.value = 0;
        lastDx.value = 0;
        lastT.value = Date.now();
      })
      .onTouchesMove((e, sm) => {
        'worklet';
        const t = e.allTouches[0];
        if (!t) return;
        const dx = t.absoluteX - startX.value;
        const dy = t.absoluteY - startY.value;
        if (decided.value === 0) {
          // 竖着滑（呼出/收起工具栏）→ 不是我们的
          if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { decided.value = 2; sm.fail(); return; }
          // 按住不动超过一会儿 → 是长按选字，让给页面
          if (Date.now() - downAt.value > HOLD_MS) { decided.value = 2; sm.fail(); return; }
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            decided.value = 1;
            // 从"开始拖"这一刻算起，页面不会一下子跳 10 多 px；但最多只扣 12：
            // 快速甩动时第一个触摸事件可能已经走了一大截，全扣掉会把这一甩吃掉
            baseDx.value = Math.max(-12, Math.min(12, dx));
            lastDx.value = dx;
            lastT.value = Date.now();
            busySV.value = true;
            sm.activate();
            runOnJS(dragStartJS)();
          } else {
            return;
          }
        }
        if (decided.value === 1) {
          // 手指速度：相邻两次触摸事件之间的位移/时间，做一点平滑（取最近几次的加权）
          const now = Date.now();
          const dt = now - lastT.value;
          if (dt > 0) {
            const inst = ((dx - lastDx.value) / dt) * 1000;
            velX.value = velX.value * 0.4 + inst * 0.6;
            lastDx.value = dx;
            lastT.value = now;
          }
          let x = dx - baseDx.value;
          // 对面没有可翻的页：只给一点阻尼位移，暗示"到头了"
          if ((x < 0 && !hasNextSV.value) || (x > 0 && !hasPrevSV.value)) x *= 0.25;
          x = Math.max(-width, Math.min(width, x));
          dragX.value = x;
          if (x > 0 && hasPrevSV.value) {
            // 往前翻：上一页从左边滑进来盖住当前页，当前页不动
            if (!backSV.value) { backSV.value = true; runOnJS(setBackJS)(true); }
            curTx.value = 0;
            if (prevTx) prevTx.value = -width + x;
          } else {
            // 往后翻（当前页向左走）；或者到头了没有可翻的页（当前页带一点阻尼位移）
            curTx.value = x;
            if (prevTx && backSV.value) prevTx.value = -width; // 手指从右拖又拖回左边：上一页退回屏幕左侧之外
          }
        }
      })
      .onEnd((e) => {
        'worklet';
        if (decided.value !== 1) return;
        const x = dragX.value;
        // 松手前 80ms 内手指已经停住了（比如拖到一半停下再松手）→ 速度按 0 算，不能把之前的速度带过来
        // 触摸事件稀疏时（一甩只有两三个事件）平滑速度会偏低，再算一个"整段平均速度"，两个取大的
        const heldMs = Math.max(1, Date.now() - downAt.value);
        const avgV = ((x + baseDx.value) / heldMs) * 1000;
        const sm = Date.now() - lastT.value > 80 ? 0 : velX.value;
        const v = Math.abs(avgV) > Math.abs(sm) && (avgV * sm >= 0 || sm === 0) ? avgV : sm;
        const dir = x < 0 ? 1 : -1; // 1=往后翻(下一页) -1=往前翻
        const can = dir === 1 ? hasNextSV.value : hasPrevSV.value;
        const progress = Math.abs(x) / width;
        const along = dir === 1 ? -v : v; // 沿"翻页方向"的速度，正=朝翻页方向甩
        // 拖过 30% 且没有明显往回甩 → 翻；没到 30% 但朝翻页方向甩得够快 → 也翻。
        // 注意手势库的速度单位是 dp/秒（不是像素）：普通手指轻轻一甩约 500~1500，
        // 门槛取 350，太高的话正常的轻甩翻不动。
        const go = can && (progress > 0.3 ? along > -200 : (along > 350 && progress > 0.03));
        if (go) {
          const remaining = width - Math.abs(x);
          const speed = Math.max(Math.abs(v), 600);
          const dur = Math.max(110, Math.min(260, (remaining / speed) * 1000 + 70));
          if (dir === 1) {
            curTx.value = withTiming(-width, { duration: dur, easing: Easing.out(Easing.cubic) }, (finished) => {
              'worklet';
              if (finished) runOnJS(finishJS)(dir);
            });
          } else {
            // 往前翻：上一页滑到位（位移 0）
            prevTx.value = withTiming(0, { duration: dur, easing: Easing.out(Easing.cubic) }, (finished) => {
              'worklet';
              if (finished) runOnJS(finishJS)(dir);
            });
          }
        } else if (backSV.value && prevTx && x > 0) {
          // 往前翻没拖够：上一页退回屏幕左侧之外，再回到最底层
          prevTx.value = withTiming(-width, { duration: 200, easing: Easing.out(Easing.cubic) }, (finished) => {
            'worklet';
            if (finished) {
              backSV.value = false;
              busySV.value = false;
              runOnJS(cancelJS)();
            }
          });
        } else {
          curTx.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) }, (finished) => {
            'worklet';
            if (finished) {
              backSV.value = false;
              busySV.value = false;
              runOnJS(cancelJS)();
            }
          });
        }
      });
  }, [curTx, prevTx, width, dragEnabled, startX, startY, downAt, baseDx, velX, lastDx, lastT, decided, dragX, busySV, backSV, hasNextSV, hasPrevSV, dragStartJS, setBackJS, finishJS, cancelJS]);

  useImperativeHandle(ref, () => ({
    isBusy: () => busyRef.current,
    // 给外面清选区用：只对"当前页"注入脚本
    injectJavaScript: (js) => {
      const w = webMapRef.current.get(pagesRef.current.cur ? pagesRef.current.cur.key : null);
      return w && w.injectJavaScript && w.injectJavaScript(js);
    },
    // 换主题：不重建页面，直接把新的底色/字色注入所有已挂载的页面
    applyTheme: (t) => {
      themeRef.current = t;
      const js = `(function(){var d=document,b=d.body;if(!b)return;d.documentElement.style.background='${t.background}';b.style.background='${t.background}';b.style.color='${t.color}';})();true;`;
      webMapRef.current.forEach((w) => w && w.injectJavaScript && w.injectJavaScript(js));
    },
    // 点边缘翻一页（一段固定动画）：dir = +1（下一页）/ -1（上一页）。
    // 对面页面还没挂上/没加载好会先等一小会儿；对面根本没有页面返回 false，外面退回"直接跳转"。
    turn: (dir) => {
      const p = pagesRef.current;
      const target = dir > 0 ? p.next : p.prev;
      if (!p.cur || !target || !width || busyRef.current) return false;
      const startKey = p.cur.key;
      busyRef.current = true;
      busySV.value = true;
      let started = false;
      const run = () => {
        if (started) return;
        started = true;
        const q = pagesRef.current;
        if (!q.cur || q.cur.key !== startKey) { busyRef.current = false; busySV.value = false; return; }
        if (dir > 0) {
          // 往后翻：当前页向左滑走，露出下一页
          const c = getTx(startKey);
          if (reduceMotionRef.current) { c.value = -width; finishJS(dir); return; }
          c.value = withTiming(-width, { duration: TURN_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
            'worklet';
            if (finished) runOnJS(finishJS)(dir);
          });
          return;
        }
        // 往前翻：上一页从左边滑进来盖住当前页。先把它挪到屏幕左侧之外、再提到最上层，
        // 等这次渲染生效（约 2 帧）再开始滑，否则上一页会在当前页上面闪一下
        const pv = getTx(q.prev.key);
        const prevKey = q.prev.key;
        pv.value = -width;
        backSV.value = true;
        setBackMode(true);
        setTimeout(() => {
          const r = pagesRef.current;
          if (!r.cur || r.cur.key !== startKey || !r.prev || r.prev.key !== prevKey) {
            backSV.value = false; setBackMode(false); busyRef.current = false; busySV.value = false; return;
          }
          if (reduceMotionRef.current) { pv.value = 0; finishJS(dir); return; }
          pv.value = withTiming(0, { duration: TURN_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
            'worklet';
            if (finished) runOnJS(finishJS)(dir);
          });
        }, 40);
      };
      if (loadedRef.current.has(target.key) && mountedKeysRef.current.has(target.key)) {
        run();
      } else {
        const waiters = loadWaitersRef.current.get(target.key) || [];
        waiters.push(run);
        loadWaitersRef.current.set(target.key, waiters);
        setTimeout(run, LOAD_WAIT_MAX_MS);
      }
      return true;
    },
  }), [width, busySV, backSV, finishJS]);

  const list = [
    showPrev && pages.prev ? { role: 'prev', page: pages.prev } : null,
    cur ? { role: 'cur', page: cur } : null,
    showNext && pages.next ? { role: 'next', page: pages.next } : null,
  ].filter(Boolean);

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        style={[styles.host, { backgroundColor: background }]}
        onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      >
        {width > 0 ? list.map(({ role, page }) => (
          <PagerPage
            key={page.key}
            page={page}
            role={role}
            width={width}
            tx={getTx(page.key)}
            backMode={backMode}
            isCurrentRef={isCurrentRef}
            onMessageRef={onMessageRef}
            registerWeb={registerWeb}
            onLoaded={handleLoaded}
            baseUrl={baseUrl}
            allowFileAccess={allowFileAccess}
            background={background}
          />
        )) : null}
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  host: { flex: 1, position: 'relative' },
  slot: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  web: { flex: 1, position: 'relative', overflow: 'hidden' },
});

export default StandardPager;
