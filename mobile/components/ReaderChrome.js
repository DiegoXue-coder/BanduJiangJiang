// 沉浸式阅读器的"外壳"：玻璃顶栏、玻璃底部面板、收起态的底部信息条。
// 与渲染器无关（不知道正文是标准阅读还是原版 EPUB），只认 props——这样原版 EPUB
// 模式以后可以套同一层壳（任务卡 08 §4 的决策待拍板）。
//
// 视觉规格唯一依据：docs/设计稿/ChatBook阅读器沉浸式样板.html，数值直接抄自它的 CSS：
//   .glass 底色 rgba(103,84,66,.75)、白字、blur(14px)；与正文交界 1px rgba(255,255,255,.22)
//   .glass.top    padding 14 10 10；.glass.bottom padding 14 18 20，行间距 14
//   .ib 按钮 40×40 圆角 10；.ttl 15px/600/字距 .06em
//   .prow 13px；.lab 宽 30；.val 宽 34 右对齐 600；.aS 12px 宽 16；.aL 22px 宽 20
//   滑块 轨道 3px rgba(255,255,255,.4)、圆钮 20px 白色
//   .seg 三等分、gap 8、按钮高 38 圆角 10 边 1px rgba(255,255,255,.4)，选中底 rgba(255,255,255,.92) 字 #54402c
//   .themes 圆点 24px 边 2px rgba(255,255,255,.5)，选中边 #fff
//   .hint 高 44、左右 26、12px、字色随阅读主题；呼出时淡出
//   浮层动画 ≈250ms，尊重系统"减少动态效果"。
//
// 【用户反馈后的调整】样板的底部面板把 进度/字号/字体/主题 一次性全摊开，占高太多。
// 用户拿其他阅读器对比后要求"收敛"：呼出后底部只有一排图标（目录/进度/主题/字体），
// 点哪个才在上面展开对应的一小块（一次只开一个）；顶栏也收薄、目录挪到底部图标里。
// 玻璃配色、按钮/滑块/圆点的具体数值仍沿用样板；变的是"信息层级"，不是视觉语言。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Easing, AccessibilityInfo,
} from 'react-native';
import Slider from '@react-native-community/slider';
import Svg, { Rect } from 'react-native-svg';
import {
  IconChevronLeft, IconList, IconHeadphones, IconMessageCircle, IconProgress, IconBrightness, IconTextSize,
} from '@tabler/icons-react-native';
import { getBatteryModule, getBlurView } from '../lib/nativeCaps';

const GLASS_BG = 'rgba(103,84,66,0.75)';
const GLASS_LINE = 'rgba(255,255,255,0.22)';
const WHITE_DIM = 'rgba(255,255,255,0.88)';
export const READER_INFO_STRIP_HEIGHT = 44;
const ANIM_MS = 250;

// 阅读主题下信息条的字色（样板 .device[data-rt] 的 --mut）
const MUTED_BY_THEME = {
  paper: 'rgba(91,70,54,0.72)',
  light: 'rgba(26,26,46,0.62)',
  dark: 'rgba(220,220,230,0.66)',
};

function pad2(n) { return n < 10 ? `0${n}` : String(n); }

// 跟随手机系统的当前时间 HH:MM（样板 tick()：每 15 秒刷新）
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

// 电量 0~1。expo-battery 不可用（旧安装包）时返回 null，调用方不画电池。
function useBatteryLevel() {
  const [level, setLevel] = useState(null);
  useEffect(() => {
    const Battery = getBatteryModule();
    if (!Battery) return undefined;
    let alive = true;
    let sub = null;
    Battery.getBatteryLevelAsync()
      .then((v) => { if (alive && typeof v === 'number' && v >= 0) setLevel(v); })
      .catch(() => {});
    try {
      sub = Battery.addBatteryLevelListener(({ batteryLevel }) => {
        if (alive && typeof batteryLevel === 'number' && batteryLevel >= 0) setLevel(batteryLevel);
      });
    } catch (e) { /* 监听不可用就只显示一次读数 */ }
    return () => { alive = false; if (sub && sub.remove) sub.remove(); };
  }, []);
  return level;
}

function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduce(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(!!v));
    return () => { alive = false; sub && sub.remove && sub.remove(); };
  }, []);
  return reduce;
}

// 样板里 drawBat()：24×12 的电池图标 + 电量数字
function BatteryIcon({ level, color }) {
  const w = Math.max(1, Math.round(14 * level));
  return (
    <View style={styles.batRow}>
      <Svg width={24} height={12} viewBox="0 0 24 12" fill="none">
        <Rect x={0.75} y={0.75} width={19} height={10.5} rx={2.5} stroke={color} strokeWidth={1.5} />
        <Rect x={3} y={3} width={w} height={6} rx={1} fill={color} />
        <Rect x={21} y={4} width={2} height={4} rx={1} fill={color} />
      </Svg>
      <Text style={[styles.infoText, { color }]}>{Math.round(level * 100)}%</Text>
    </View>
  );
}

// 底部图标按钮：图标 + 一行小字（小字帮不熟悉的人认图标）；当前展开的那个高亮
function BarButton({ icon, label, active, onPress, enabled }) {
  return (
    <TouchableOpacity
      style={[styles.barBtn, active && styles.barBtnOn, !enabled && styles.disabled]}
      disabled={!enabled}
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      {icon}
      <Text style={styles.barLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// 玻璃底：能真模糊就模糊，不能就只用半透明底色（"只靠半透明也好看"的降级）
function GlassBackground() {
  const BlurView = getBlurView();
  return (
    <>
      {BlurView ? (
        // tint 用 "default" 而不是 "dark"：样板的玻璃只有"半透明底色 + blur"，没有额外暗色蒙层。
        // 实测（新原生包）tint="dark" 会让玻璃叠在白底上从样板的 (141,127,113) 变深到约 (104,88,71)。
        <BlurView
          intensity={40}
          tint="light"
          experimentalBlurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_BG }]} />
    </>
  );
}

export default function ReaderChrome({
  open,
  insets,
  readerTheme, // 'paper' | 'light' | 'dark'（阅读主题，决定信息条字色与主题按钮高亮）
  bookTitle,
  chapterTitle,
  percent, // 0~100 整数
  progress, // 0~1
  onSeek, // (0~1) => void，拖动结束时调用
  fontSize, // 12~28
  onFontSize,
  fonts, // [{key,label,previewFamily}]
  fontKey,
  onFont,
  themes, // [{key,label,swatch}]
  onTheme,
  onBack,
  onToc,
  onListen,
  onAsk,
  enabled = true,
}) {
  const reduceMotion = useReduceMotion();
  const anim = useRef(new Animated.Value(open ? 1 : 0)).current;
  const [topH, setTopH] = useState(120);
  const [bottomH, setBottomH] = useState(300);
  // 二级面板：null | 'progress' | 'theme' | 'font'，一次只开一个；工具栏收起时复位
  const [panel, setPanel] = useState(null);
  useEffect(() => { if (!open) setPanel(null); }, [open]);
  const clock = useClock();
  const battery = useBatteryLevel();
  const muted = MUTED_BY_THEME[readerTheme] || MUTED_BY_THEME.paper;

  useEffect(() => {
    if (reduceMotion) { anim.setValue(open ? 1 : 0); return; }
    Animated.timing(anim, {
      toValue: open ? 1 : 0, duration: ANIM_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [open, reduceMotion, anim]);

  // 拖动进度时实时显示百分比，松手才真正跳转（分页重算较重，不逐帧跳）
  const [dragging, setDragging] = useState(null);
  const shownPercent = dragging === null ? percent : Math.round(dragging * 100);

  const topTranslate = anim.interpolate({ inputRange: [0, 1], outputRange: [-topH - 2, 0] });
  const bottomTranslate = anim.interpolate({ inputRange: [0, 1], outputRange: [bottomH + 2, 0] });
  const stripOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  const sliderProps = useMemo(() => ({
    minimumTrackTintColor: '#ffffff',
    maximumTrackTintColor: 'rgba(255,255,255,0.4)',
    thumbTintColor: '#ffffff',
  }), []);

  return (
    <>
      {/* 收起态底部信息条：左 时间+电量，中 章节名，右 百分比（不显示页数/书名） */}
      <Animated.View
        pointerEvents="none"
        style={[styles.strip, { height: READER_INFO_STRIP_HEIGHT + insets.bottom, paddingBottom: 8 + insets.bottom, opacity: stripOpacity }]}
      >
        <View style={styles.stripLeft}>
          <Text style={[styles.infoText, { color: muted }]}>{clock}</Text>
          {battery !== null ? <BatteryIcon level={battery} color={muted} /> : null}
        </View>
        <Text style={[styles.stripCenter, { color: muted }]} numberOfLines={1}>{chapterTitle}</Text>
        <Text style={[styles.stripRight, { color: muted }]}>{percent}%</Text>
      </Animated.View>

      {/* 玻璃顶栏（收薄）：返回、书名、听书、问AI。目录挪到底部图标栏。 */}
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        onLayout={(e) => setTopH(e.nativeEvent.layout.height)}
        style={[styles.glass, styles.top, { paddingTop: 6 + insets.top, transform: [{ translateY: topTranslate }] }]}
      >
        <GlassBackground />
        <TouchableOpacity style={styles.ib} onPress={onBack} accessibilityLabel="返回">
          <IconChevronLeft color="#fff" size={22} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.ttl} numberOfLines={1}>{bookTitle}</Text>
        <TouchableOpacity style={[styles.ib, !enabled && styles.disabled]} disabled={!enabled} onPress={onListen} accessibilityLabel="听书">
          <IconHeadphones color="#fff" size={22} strokeWidth={2} />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.ib, !enabled && styles.disabled]} disabled={!enabled} onPress={onAsk} accessibilityLabel="问AI">
          <IconMessageCircle color="#fff" size={22} strokeWidth={2} />
        </TouchableOpacity>
      </Animated.View>

      {/* 玻璃底部：一排图标 + 点开才出现的二级小面板（一次只开一个） */}
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        onLayout={(e) => setBottomH(e.nativeEvent.layout.height)}
        style={[styles.glass, styles.bottom, { transform: [{ translateY: bottomTranslate }] }]}
      >
        <GlassBackground />

        {panel === 'progress' ? (
          <View style={[styles.subPanel, styles.prow]}>
            <Text style={styles.lab}>进度</Text>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={1000}
              step={1}
              value={Math.round(progress * 1000)}
              disabled={!enabled}
              onValueChange={(v) => setDragging(v / 1000)}
              onSlidingComplete={(v) => { setDragging(null); onSeek && onSeek(v / 1000); }}
              {...sliderProps}
            />
            <Text style={styles.val}>{shownPercent}%</Text>
          </View>
        ) : null}

        {panel === 'font' ? (
          <View style={[styles.subPanel, { gap: 12 }]}>
            <View style={styles.prow}>
              <Text style={styles.aS}>A</Text>
              <Slider
                style={styles.slider}
                minimumValue={12}
                maximumValue={28}
                step={1}
                value={fontSize}
                disabled={!enabled}
                onSlidingComplete={(v) => onFontSize && onFontSize(Math.round(v))}
                {...sliderProps}
              />
              <Text style={styles.aL}>A</Text>
              <Text style={styles.val}>{fontSize}</Text>
            </View>
            <View style={styles.seg}>
              {fonts.map((f) => {
                const on = f.key === fontKey;
                return (
                  <TouchableOpacity
                    key={f.key}
                    disabled={!enabled}
                    style={[styles.segBtn, on && styles.segBtnOn]}
                    onPress={() => onFont && onFont(f.key)}
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.segText, { fontFamily: f.previewFamily }, on && styles.segTextOn]}>{f.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}

        {panel === 'theme' ? (
          <View style={[styles.subPanel, styles.themes]}>
            {themes.map((t) => {
              const on = t.key === readerTheme;
              return (
                <TouchableOpacity
                  key={t.key}
                  disabled={!enabled}
                  style={styles.sw}
                  onPress={() => onTheme && onTheme(t.key)}
                  accessibilityState={{ selected: on }}
                >
                  <View style={[styles.swDot, { backgroundColor: t.swatch }, on && styles.swDotOn]} />
                  <Text style={styles.swText}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}

        <View style={[styles.iconBar, { paddingBottom: 6 + insets.bottom }]}>
          <BarButton
            label="目录" enabled={enabled} active={false}
            onPress={onToc}
            icon={<IconList color="#fff" size={22} strokeWidth={1.9} />}
          />
          <BarButton
            label="进度" enabled={enabled} active={panel === 'progress'}
            onPress={() => setPanel((p) => (p === 'progress' ? null : 'progress'))}
            icon={<IconProgress color="#fff" size={22} strokeWidth={1.9} />}
          />
          <BarButton
            label="主题" enabled={enabled} active={panel === 'theme'}
            onPress={() => setPanel((p) => (p === 'theme' ? null : 'theme'))}
            icon={<IconBrightness color="#fff" size={22} strokeWidth={1.9} />}
          />
          <BarButton
            label="字体" enabled={enabled} active={panel === 'font'}
            onPress={() => setPanel((p) => (p === 'font' ? null : 'font'))}
            icon={<IconTextSize color="#fff" size={22} strokeWidth={1.9} />}
          />
        </View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  glass: { position: 'absolute', left: 0, right: 0, zIndex: 5, overflow: 'hidden' },
  // 顶栏收薄：上下留白 14/10 -> 6/6，按钮 40 -> 36
  top: {
    top: 0, paddingBottom: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4,
    borderBottomWidth: 1, borderBottomColor: GLASS_LINE,
  },
  bottom: {
    bottom: 0, borderTopWidth: 1, borderTopColor: GLASS_LINE,
  },
  ib: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  // 二级小面板：贴在图标栏上方，与图标栏之间一条分隔线
  subPanel: {
    paddingTop: 14, paddingBottom: 14, paddingHorizontal: 18,
    borderBottomWidth: 1, borderBottomColor: GLASS_LINE,
  },
  iconBar: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 6, paddingHorizontal: 8 },
  barBtn: {
    minWidth: 64, paddingVertical: 4, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  barBtnOn: { backgroundColor: 'rgba(255,255,255,0.16)' },
  barLabel: { color: WHITE_DIM, fontSize: 11 },
  disabled: { opacity: 0.4 },
  ttl: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 15, fontWeight: '600', letterSpacing: 0.9 },

  prow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lab: { width: 30, color: WHITE_DIM, fontSize: 13 },
  val: { width: 34, textAlign: 'right', color: '#fff', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  aS: { width: 16, textAlign: 'center', color: '#fff', fontSize: 12 },
  aL: { width: 20, textAlign: 'center', color: '#fff', fontSize: 22, lineHeight: 24 },
  slider: { flex: 1, height: 26 },

  seg: { flexDirection: 'row', gap: 8 },
  segBtn: {
    flex: 1, height: 38, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  segBtnOn: { backgroundColor: 'rgba(255,255,255,0.92)', borderColor: 'transparent' },
  segText: { color: '#fff', fontSize: 15 },
  segTextOn: { color: '#54402c', fontWeight: '600' },

  themes: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  sw: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 2 },
  swDot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)' },
  swDotOn: { borderColor: '#fff', shadowColor: '#fff', shadowOpacity: 0.35, shadowRadius: 0, elevation: 0 },
  swText: { color: '#fff', fontSize: 12 },

  strip: {
    position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 4,
    paddingHorizontal: 26, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10,
  },
  stripLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  stripCenter: { maxWidth: 150, fontSize: 12, textAlign: 'center' },
  stripRight: { flex: 1, textAlign: 'right', fontSize: 12, fontVariant: ['tabular-nums'] },
  infoText: { fontSize: 12, fontVariant: ['tabular-nums'] },
  batRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
