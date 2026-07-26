// 阶段十二：知识图谱 v1——替换"关联主题"扁平列表。
//
// 技术选型（决策记录，见04-开发进度记录.md）：d3-force算力导向布局的静态
// 坐标（纯JS，无原生绑定）+ react-native-svg画图（阶段十一已验证真机能用）
// + react-native-reanimated在静态坐标上叠加持续的漂浮动效（阶段十已验证）。
// 2026-07-26修订：原定"v1只支持点击、不支持拖拽"改成支持双指缩放+拖拽平移
// +双击切换缩放（决策层真机验收时改的主意，05-验收标准.md已同步更新）。
// 用react-native-gesture-handler（阶段三已装、App.js根节点已包过
// GestureHandlerRootView，不新增原生依赖）在外层包一个Animated.View做
// 缩放平移变换，SVG内部各节点/连线自己的onPress保持不变、不用重新做
// 命中测试。
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
  Pressable, ScrollView,
} from 'react-native';
import Svg, { Circle, Line, Text as SvgText, G } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedProps, useAnimatedStyle, withRepeat, withTiming, Easing,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from 'd3-force';
import { useFocusEffect } from '@react-navigation/native';
import { getConceptGraph } from '../lib/api';
import { useTheme } from '../theme';
import { FONTS } from '../fonts';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.2;

// 深色星空感背景是图谱区域自己固定的视觉风格，不跟随App的亮色/暗色主题
// 切换——星空氛围本身就该是暗的，跟着切成亮色反而破坏设计意图。
const SPACE_BG = '#12141F';
const STAR_COLOR = 'rgba(255,255,255,0.18)';
const EDGE_COLOR = 'rgba(200,195,220,0.22)';

// 节点颜色按思想流派分组（不是按书——一个概念可能横跨多本书），三个流派
// 目前够用，颜色数量卡在2-3个之内，避免每本书一个颜色导致的视觉噪音。
const CATEGORY_COLOR = {
  '道家': '#7FC9B8',
  '儒家': '#E0B15C',
  '墨家': '#A48FD1',
  '其他': '#8B96AC',
};

function computeLayout(nodes, edges) {
  if (nodes.length === 0) return [];
  const simNodes = nodes.map((n) => ({ ...n }));
  const simLinks = edges
    .map((e) => ({ source: e.source, target: e.target }))
    // d3-force 的 forceLink 要求 source/target 能在节点数组里找到对应id，
    // 后端理论上不会返回悬空引用，但防御一下避免脏数据直接让模拟崩掉
    .filter((l) => simNodes.some((n) => n.id === l.source) && simNodes.some((n) => n.id === l.target));

  const sim = forceSimulation(simNodes)
    .force('charge', forceManyBody().strength(-90))
    .force('link', forceLink(simLinks).id((d) => d.id).distance(75))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide((d) => 16 + Math.min(d.size, 8) * 2.5))
    .stop();
  // 力导向布局是v1的静态排布，不是每帧都在跑的实时物理——收敛到稳定位置
  // 后就停，节省性能，跟"漂浮动效"（reanimated负责，见FloatingNode）是
  // 两套完全独立的动画层
  for (let i = 0; i < 300; i += 1) sim.tick();
  return simNodes;
}

// 每个节点在算好的静态坐标之上，叠加一个独立、参数各自随机的漂浮偏移
// 动画——幅度小（4-8px）、周期长且互不相同（2.6-4.4秒），看起来是自然
// 漂浮不是同步机械抖动。
function FloatingNode({ node, onPress }) {
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  const duration = useMemo(() => 2600 + Math.random() * 1800, []);
  const amplitude = useMemo(() => 4 + Math.random() * 4, []);
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const angle = phase + t.value * Math.PI * 2;
    return {
      cx: node.x + Math.cos(angle) * amplitude,
      cy: node.y + Math.sin(angle) * amplitude,
    };
  });

  const radius = 10 + Math.min(node.size, 8) * 2.5;
  const color = CATEGORY_COLOR[node.category] || CATEGORY_COLOR['其他'];

  return (
    <AnimatedCircle
      animatedProps={animatedProps}
      r={radius}
      fill={color}
      opacity={0.88}
      onPress={() => onPress(node)}
    />
  );
}

function NodeDetailModal({ node, theme, onClose }) {
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.55)' }]} onPress={onClose} />
      <View pointerEvents="box-none" style={styles.modalWrap}>
        <View style={[styles.modalCard, { backgroundColor: theme.cardBg, borderRadius: theme.radius, borderColor: theme.cardBorder }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: theme.text }]} numberOfLines={1}>{node.label}</Text>
            <TouchableOpacity onPress={onClose} style={styles.modalCloseBtn}>
              <Text style={[styles.modalCloseText, { color: theme.textSecondary }]}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
            {(node.sources || []).map((s, i) => (
              <View
                key={i}
                style={[styles.sourceItem, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.cardBorder }]}
              >
                <Text style={[styles.sourceBook, { color: theme.accent }]}>{s.book_title}</Text>
                <Text style={[styles.sourceExcerpt, { color: theme.text }]}>"{s.excerpt}"</Text>
                {!!s.explanation && (
                  <Text style={[styles.sourceExplain, { color: theme.textSecondary }]}>{s.explanation}</Text>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

function EdgeDetailModal({ edge, nodeA, nodeB, theme, onClose }) {
  const sideCard = (node, explanation) => (
    <View style={[styles.mindmapCard, { backgroundColor: theme.bg, borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
      <Text style={[styles.mindmapLabel, { color: theme.text }]} numberOfLines={1}>{node?.label || ''}</Text>
      <Text style={[styles.mindmapExplain, { color: theme.textSecondary }]}>{explanation}</Text>
      {!!node?.sources?.length && (
        <Text style={[styles.mindmapSource, { color: theme.textMuted }]} numberOfLines={2}>
          {node.sources[0].book_title} · "{node.sources[0].excerpt}"
        </Text>
      )}
    </View>
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.55)' }]} onPress={onClose} />
      <View pointerEvents="box-none" style={styles.modalWrap}>
        <View style={[styles.modalCard, { backgroundColor: theme.cardBg, borderRadius: theme.radius, borderColor: theme.cardBorder }]}>
          <TouchableOpacity onPress={onClose} style={styles.modalCloseBtnAbs}>
            <Text style={[styles.modalCloseText, { color: theme.textSecondary }]}>✕</Text>
          </TouchableOpacity>
          <View style={[styles.commonPointBox, { backgroundColor: theme.accentSoft, borderRadius: theme.radius }]}>
            <Text style={[styles.commonPointText, { color: theme.accent }]}>{edge.common_point}</Text>
          </View>
          <View style={styles.mindmapRow}>
            {sideCard(nodeA, edge.explanation_a)}
            {sideCard(nodeB, edge.explanation_b)}
          </View>
        </View>
      </View>
    </View>
  );
}

export default function ConceptGraph() {
  const theme = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  // 容器实际可用尺寸——之前写死480高度，在真机上比"划线复盘"页头部+
  // tab栏之下真正剩余的空间矮了一大截，下面空出一整块背景色，靠onLayout
  // 量真实尺寸才对得上。
  const [containerSize, setContainerSize] = useState(null);
  const starsRef = useRef(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await getConceptGraph();
      setData(d);
    } catch (e) {
      setError(e.message || '加载失败');
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const layoutNodes = useMemo(() => {
    if (!data) return [];
    return computeLayout(data.nodes, data.edges);
  }, [data]);

  const nodeById = useMemo(() => {
    const m = new Map();
    layoutNodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [layoutNodes]);

  // 力导向布局算出来的坐标范围可能比容器宽/高得多（159个节点铺得很开），
  // 之前直接用SCREEN_W×固定高度当画布、没设viewBox，超出这个像素范围的
  // 节点全部被裁掉看不见——159个节点只露出了一小撮。改成按算出来的节点
  // 坐标包围盒设viewBox+preserveAspectRatio="xMidYMid meet"，整张图谱
  // 缩放适配到容器里，不管布局实际多大，全部节点都保证在可视范围内。
  const viewBox = useMemo(() => {
    if (layoutNodes.length === 0 || !containerSize) return null;
    const pad = 60; // 留出节点半径+标签文字的空间，不然边缘节点的label被切
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let sumX = 0, sumY = 0;
    layoutNodes.forEach((n) => {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      sumX += n.x; sumY += n.y;
    });
    // 用节点质心（坐标平均值）当画布中心，不用包围盒几何中点——159个节点里
    // 115个是孤立点（没有关联边），力导向布局收敛后视觉密度天然不对称
    // （连线多的那一小片聚得紧、孤立点松散地飘在外围），几何中点居中会让
    // 视觉上"密"的那一片偏向画布一侧、留白看起来不对称（真机截图复现过
    // 这个现象：上方大片空白、下方紧贴边缘没留白）。质心按视觉重量对齐，
    // 半径取"质心到最远节点"的距离对称展开，保证居中的同时也不裁掉节点。
    const centroidX = sumX / layoutNodes.length;
    const centroidY = sumY / layoutNodes.length;
    const halfW = Math.max(maxX - centroidX, centroidX - minX) + pad;
    const halfH = Math.max(maxY - centroidY, centroidY - minY) + pad;
    const w = Math.max(halfW * 2, containerSize.width);
    const h = Math.max(halfH * 2, containerSize.height);
    return `${centroidX - w / 2} ${centroidY - h / 2} ${w} ${h}`;
  }, [layoutNodes, containerSize]);

  // 双指缩放/拖拽平移的手势状态——默认(scale=1, translate=0)就是上面viewBox
  // 算出来的"全部节点适配进屏幕"这个默认视图，缩放平移是叠加在这个默认帧
  // 之上的图层变换（外层Animated.View的transform），不影响内部SVG自己的
  // viewBox坐标系，所以内部各节点/连线的onPress命中测试完全不用改。
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  useEffect(() => {
    // 每次重新拉取图谱数据（比如新增了划线触发重新构建）都回到默认视图，
    // 不残留上一次的缩放/平移状态。
    scale.value = 1; savedScale.value = 1;
    translateX.value = 0; savedTranslateX.value = 0;
    translateY.value = 0; savedTranslateY.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const pinchGesture = useMemo(() => Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(Math.max(savedScale.value * e.scale, MIN_ZOOM), MAX_ZOOM);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    }), []);

  const panGesture = useMemo(() => Gesture.Pan()
    .onUpdate((e) => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    }), []);

  const doubleTapGesture = useMemo(() => Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const zoomedIn = scale.value > 1.05;
      const nextScale = zoomedIn ? MIN_ZOOM : DOUBLE_TAP_ZOOM;
      scale.value = withTiming(nextScale, { duration: 220 });
      translateX.value = withTiming(0, { duration: 220 });
      translateY.value = withTiming(0, { duration: 220 });
      savedScale.value = nextScale;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
    }), []);

  const composedGesture = useMemo(
    () => Gesture.Exclusive(doubleTapGesture, Gesture.Simultaneous(pinchGesture, panGesture)),
    [doubleTapGesture, pinchGesture, panGesture],
  );

  const animatedTransformStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  if (data === null && !error) {
    return (
      <View style={[styles.centerBox, { backgroundColor: SPACE_BG }]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centerBox, { backgroundColor: SPACE_BG }]}>
        <Text style={[styles.errorText, { color: '#E39B90' }]}>加载失败：{error}</Text>
        <TouchableOpacity style={[styles.retryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]} onPress={load}>
          <Text style={{ color: theme.textOnAccent, fontWeight: '600' }}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (data.nodes.length === 0) {
    return (
      <View style={[styles.centerBox, { backgroundColor: SPACE_BG }]}>
        <Text style={styles.emptyText}>
          暂时还没有提炼出概念{'\n'}多划线、多提问，AI 会帮你梳理出思想脉络
        </Text>
      </View>
    );
  }

  if (containerSize && !starsRef.current) {
    starsRef.current = Array.from({ length: 60 }, () => ({
      x: Math.random() * containerSize.width,
      y: Math.random() * containerSize.height,
      r: 0.5 + Math.random() * 1,
    }));
  }

  return (
    <View
      style={[styles.container, { backgroundColor: SPACE_BG }]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setContainerSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
      }}
    >
      {containerSize && viewBox && (
        <GestureDetector gesture={composedGesture}>
          <Animated.View style={[{ width: containerSize.width, height: containerSize.height }, animatedTransformStyle]}>
            <Svg width={containerSize.width} height={containerSize.height} viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
              {starsRef.current.map((s, i) => (
                <Circle key={`star-${i}`} cx={s.x} cy={s.y} r={s.r} fill={STAR_COLOR} />
              ))}
              {data.edges.map((e, i) => {
                const a = nodeById.get(e.source);
                const b = nodeById.get(e.target);
                if (!a || !b) return null;
                return (
                  <G key={`edge-${i}`}>
                    <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={EDGE_COLOR} strokeWidth={1} />
                    {/* 加宽的透明命中区域，手指点细线不好点准 */}
                    <Line
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="transparent" strokeWidth={22}
                      onPress={() => setSelectedEdge(e)}
                    />
                  </G>
                );
              })}
              {layoutNodes.map((n) => (
                <SvgText
                  key={`label-${n.id}`}
                  x={n.x}
                  y={n.y + 10 + Math.min(n.size, 8) * 2.5 + 14}
                  fill="rgba(255,255,255,0.75)"
                  fontSize={11}
                  fontFamily={FONTS.sansRegular}
                  textAnchor="middle"
                >
                  {n.label}
                </SvgText>
              ))}
              {layoutNodes.map((n) => (
                <FloatingNode key={n.id} node={n} onPress={setSelectedNode} />
              ))}
            </Svg>
          </Animated.View>
        </GestureDetector>
      )}

      {selectedNode && (
        <NodeDetailModal node={selectedNode} theme={theme} onClose={() => setSelectedNode(null)} />
      )}
      {selectedEdge && (
        <EdgeDetailModal
          edge={selectedEdge}
          nodeA={nodeById.get(selectedEdge.source)}
          nodeB={nodeById.get(selectedEdge.target)}
          theme={theme}
          onClose={() => setSelectedEdge(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, width: '100%' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 12 },
  emptyText: { color: 'rgba(255,255,255,0.55)', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  errorText: { fontSize: 14, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10 },

  backdrop: { ...StyleSheet.absoluteFillObject },
  modalWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: {
    width: '100%', maxHeight: '80%', borderWidth: 1,
    padding: 16,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  modalTitle: { fontSize: 17, fontWeight: '700', flex: 1 },
  modalCloseBtn: { padding: 4, marginLeft: 8 },
  modalCloseBtnAbs: { position: 'absolute', top: 10, right: 10, padding: 6, zIndex: 1 },
  modalCloseText: { fontSize: 16 },
  modalBody: { maxHeight: 360 },

  sourceItem: { paddingVertical: 10 },
  sourceBook: { fontSize: 12, fontWeight: '700', marginBottom: 4 },
  sourceExcerpt: { fontSize: 14, lineHeight: 21, fontStyle: 'italic', fontFamily: FONTS.serifRegular, marginBottom: 4 },
  sourceExplain: { fontSize: 12, lineHeight: 18 },

  commonPointBox: { padding: 12, marginBottom: 14, marginTop: 8 },
  commonPointText: { fontSize: 14, fontWeight: '700', textAlign: 'center', lineHeight: 20 },
  mindmapRow: { flexDirection: 'row', gap: 10 },
  mindmapCard: { flex: 1, borderWidth: 1, padding: 10 },
  mindmapLabel: { fontSize: 13, fontWeight: '700', marginBottom: 6 },
  mindmapExplain: { fontSize: 12, lineHeight: 18, marginBottom: 6 },
  mindmapSource: { fontSize: 10, lineHeight: 14, fontFamily: FONTS.serifRegular },
});
