// 标准阅读器的"翻页容器"：整页滑动翻页，而且页面跟着手指走。
//
// ── 历史 ──────────────────────────────────────────────────────────────────────
// 改造前：一页一个 WebView，翻页=销毁旧的、新建一个、重新排版（250~450ms），画面直接跳变。
// 第一版（点一下放一段固定动画）：当前页/下一页常驻，翻页时用原生动画把当前页滑走 260ms。
// 第二版：跟手（手指拖到哪页面跟到哪，松手按距离/速度决定翻过去还是弹回），上一页也常驻。
// 现在这版：往前翻改成"上一页从左边滑进来盖住当前页"，并且**任何时候都不改页面层级**（见下）。
//
// ── 怎么做到不卡 ─────────────────────────────────────────────────────────────
// 页面位置由 Reanimated 的"共享值"驱动，手势回调和动画都跑在原生 UI 线程，
// 手指每动一下，位置直接在 UI 线程更新，不经过 JS 线程（JS 线程忙于排版也不影响跟手）。
//
// ── 页面怎么摆（重点）─────────────────────────────────────────────────────────
// 三个 WebView（上一页/当前页/下一页）常驻，而且都必须"在屏幕范围内被绘制着"：
// 完全移到屏幕外的 WebView 不会被绘制，滑进来时会先露出空白/半截内容（实测）。
//   往后翻（手指向左拖）：当前页向左滑走，露出压在下面的下一页；
//   往前翻（手指向右拖）：上一页从左边滑进来盖在当前页上面，当前页自己不动。
// 往前翻要求"上一页的层级高于当前页"，往后翻要求"当前页高于下一页"——所以**层级按页在书里的
// 先后固定**：越靠前的页层级越高（z = 基数 − 页序号），一个页面的层级一辈子不变。
// 上一页平时停在屏幕最左边、只露出 2dp 的窄边（页面左右边距是同色空白，看不出来）：
// 既一直被绘制着，又不需要在往前翻的时候临时提层。
//
// 为什么这么在意"不改层级"：一开始是静止时让上一页压在最底层、往前翻时才把它提到最上层，
// 录屏逐帧检测发现：提层（或翻完后降层）的那一帧，整页正文会空白一下（用户看到的"闪一下"），
// 点边缘往回翻大约 1/4 会闪，往后翻（没有层级变化）一次都没闪。
// 每个页面实例有自己的位移共享值：翻完之后角色互换，只有"刚滑走的旧当前页"需要从屏幕外
// 挪到左侧窄边位置（都在屏幕外，看不见），其余页的位置一像素都不用改。
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
const Z_BASE = 1000000; // 层级 = Z_BASE − 页序号（页序号越小=越靠前=层级越高）
const SLIVER = 2; // 上一页平时露在屏幕最左边的宽度（dp）

const PagerPage = React.memo(function PagerPage({
  page, role, width, tx, isCurrentRef, onMessageRef, registerWeb, onLoaded,
  baseUrl, allowFileAccess, background,
}) {
  // 层级固定（见文件头）：按页序号；没有序号（不该发生）时退回按角色
  const zIndex = page.order != null ? Z_BASE - page.order : ({ prev: 3, cur: 2, next: 1 }[role]);
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
    // 只有"当前页"的消息算数：邻页（比如它们自己的字体自检消息）一律忽略
    if (!isCurrentRef.current || isCurrentRef.current !== page.key) return;
    onMessageRef.current && onMessageRef.current(event);
  }, [isCurrentRef, onMessageRef, page.key]);
  return (
    <Animated.View
      // 只有当前页接收触摸；邻页不能被误点
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

// pages: { prev, cur, next }，每个是 { key, order, html } 或 null（书的首页没有上一页 / 末页没有下一页 /
//        相邻章节还没读进来）。key 要能唯一标识"这一页的位置+字体"，同一页不变；
//        order 是这一页在整本书里的先后序号（章序号×10000+页序号），决定它一辈子的层级。
// onCommit(dir)：翻页动画结束（页面已经滑到位）后调用，外面据此把页码 ±1。
// onDragStart：手指开始拖页面时调用（外面用来清掉选区）。
// dragEnabled：false 时不响应拖动（比如工具栏展开着），触摸原样交给页面里的脚本。
// holdMs：按住不动超过这个时间就当作长按选字、拖页手势让位（要小于页面脚本的长按触发时间）。
const StandardPager = forwardRef(function StandardPager({
  pages, baseUrl, allowFileAccess, background, onMessage, onCommit, onDragStart, dragEnabled = true, holdMs = HOLD_MS,
}, ref) {
  const [width, setWidth] = useState(0);
  const [, setLoadTick] = useState(0); // 有页面加载完就 +1，让"能不能挂邻页/能不能拖"重新计算
  const [prevForce, setPrevForce] = useState(false);

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

  // 上一页平时停的位置：屏幕左侧之外，只露出 SLIVER 宽的窄边；其他页平时在 0
  const restOf = (role) => (role === 'prev' ? -width + SLIVER : 0);
  const getTx = (key, role) => {
    let sv = txMapRef.current.get(key);
    if (!sv) { sv = makeMutable(restOf(role)); txMapRef.current.set(key, sv); }
    return sv;
  };
  // 所有页回到各自角色的停靠位置
  const restAll = () => {
    const p = pagesRef.current;
    txMapRef.current.forEach((sv, k) => {
      sv.value = (p.prev && p.prev.key === k) ? -width + SLIVER : 0;
    });
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

  // 页宽变了（旋转/折叠屏）：上一页的停靠位置要跟着重算
  useEffect(() => { if (width) restAll(); }, [width]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // 各页回到自己新角色的停靠位置：往后翻后，刚滑走的旧当前页（在屏幕左侧之外）成了上一页，
    // 只是从"完全在外"挪到"露 2dp 窄边"；往前翻后，滑进来的那页成了当前页，位置本来就是 0。
    restAll();
    busyRef.current = false;
    busySV.value = false;
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }
  }, [curKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
      restAll();
    }, 600);
  }, [busySV]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancelJS = useCallback(() => {
    busyRef.current = false;
  }, []);
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
  const dragX = useSharedValue(0); // 手指当前带来的位移（<0 往后翻，>0 往前翻），松手判定用
  const curTx = cur ? getTx(cur.key, 'cur') : null;
  const prevTx = pages.prev ? getTx(pages.prev.key, 'prev') : null;
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
          if (Date.now() - downAt.value > holdMs) { decided.value = 2; sm.fail(); return; }
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
            curTx.value = 0;
            if (prevTx) prevTx.value = Math.min(0, -width + SLIVER + x);
          } else {
            // 往后翻（当前页向左走）；或者到头了没有可翻的页（当前页带一点阻尼位移）
            curTx.value = x;
            if (prevTx) prevTx.value = -width + SLIVER; // 手指从右拖又拖回左边：上一页回到左侧窄边
          }
        }
      })
      .onEnd((e) => {
        'worklet';
        if (decided.value !== 1) return;
        const x = dragX.value;
        // 触摸事件稀疏时（一甩只有两三个事件）平滑速度会偏低，再算一个"整段平均速度"，两个取大的；
        // 松手前 80ms 内手指已经停住了（拖到一半停下再松手）→ 平滑速度按 0 算
        const heldMs = Math.max(1, Date.now() - downAt.value);
        const avgV = ((x + baseDx.value) / heldMs) * 1000;
        const smooth = Date.now() - lastT.value > 80 ? 0 : velX.value;
        const v = Math.abs(avgV) > Math.abs(smooth) && (avgV * smooth >= 0 || smooth === 0) ? avgV : smooth;
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
        } else if (x > 0 && prevTx && hasPrevSV.value) {
          // 往前翻没拖够：上一页退回左侧窄边
          prevTx.value = withTiming(-width + SLIVER, { duration: 200, easing: Easing.out(Easing.cubic) }, (finished) => {
            'worklet';
            if (finished) {
              busySV.value = false;
              runOnJS(cancelJS)();
            }
          });
        } else {
          curTx.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) }, (finished) => {
            'worklet';
            if (finished) {
              busySV.value = false;
              runOnJS(cancelJS)();
            }
          });
        }
      });
  }, [curTx, prevTx, width, dragEnabled, holdMs, startX, startY, downAt, baseDx, velX, lastDx, lastT, decided, dragX, busySV, hasNextSV, hasPrevSV, dragStartJS, finishJS, cancelJS]);

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
      const targetKey = target.key;
      busyRef.current = true;
      busySV.value = true;
      let started = false;
      const run = () => {
        if (started) return;
        started = true;
        const q = pagesRef.current;
        const t = dir > 0 ? q.next : q.prev;
        if (!q.cur || q.cur.key !== startKey || !t || t.key !== targetKey) {
          busyRef.current = false; busySV.value = false; return;
        }
        // 往后翻：动的是当前页（向左滑走）；往前翻：动的是上一页（从左侧窄边滑进来）
        const mover = dir > 0 ? getTx(startKey, 'cur') : getTx(targetKey, 'prev');
        const to = dir > 0 ? -width : 0;
        if (reduceMotionRef.current) { mover.value = to; finishJS(dir); return; }
        mover.value = withTiming(to, { duration: TURN_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
          'worklet';
          if (finished) runOnJS(finishJS)(dir);
        });
      };
      if (loadedRef.current.has(targetKey) && mountedKeysRef.current.has(targetKey)) {
        run();
      } else {
        const waiters = loadWaitersRef.current.get(targetKey) || [];
        waiters.push(run);
        loadWaitersRef.current.set(targetKey, waiters);
        setTimeout(run, LOAD_WAIT_MAX_MS);
      }
      return true;
    },
  }), [width, busySV, finishJS]); // eslint-disable-line react-hooks/exhaustive-deps

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
            tx={getTx(page.key, role)}
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
