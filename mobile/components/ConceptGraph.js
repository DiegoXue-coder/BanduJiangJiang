// 阶段十二：知识图谱 v1——替换"关联主题"扁平列表。
//
// 技术选型（决策记录，见04-开发进度记录.md）：d3-force算力导向布局的静态
// 坐标（纯JS，无原生绑定）+ react-native-svg画图（阶段十一已验证真机能用）
// + react-native-reanimated在静态坐标上叠加持续的漂浮动效（阶段十已验证）。
// v1明确不支持拖拽，只支持点击。
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
  Dimensions, Pressable, ScrollView,
} from 'react-native';
import Svg, { Circle, Line, Text as SvgText, G } from 'react-native-svg';
import Animated, { useSharedValue, useAnimatedProps, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from 'd3-force';
import { useFocusEffect } from '@react-navigation/native';
import { getConceptGraph } from '../lib/api';
import { useTheme } from '../theme';
import { FONTS } from '../fonts';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

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

const { width: SCREEN_W } = Dimensions.get('window');
const GRAPH_HEIGHT = 480;

// 固定种子的"星星"装饰点——极简、不做发光/渐变，纯静态小圆点，只在组件
// 第一次渲染时生成一次，不随节点数据刷新重新随机（避免每次重新加载图谱
// 星星位置跳动）。
const STARS = Array.from({ length: 50 }, () => ({
  x: Math.random() * SCREEN_W,
  y: Math.random() * GRAPH_HEIGHT,
  r: 0.5 + Math.random() * 1,
}));

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

  const cx = SCREEN_W / 2;
  const cy = GRAPH_HEIGHT / 2;

  return (
    <View style={[styles.container, { backgroundColor: SPACE_BG }]}>
      <Svg width={SCREEN_W} height={GRAPH_HEIGHT}>
        {STARS.map((s, i) => (
          <Circle key={`star-${i}`} cx={s.x} cy={s.y} r={s.r} fill={STAR_COLOR} />
        ))}
        <G x={cx} y={cy}>
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
        </G>
      </Svg>

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
  container: { width: '100%', height: GRAPH_HEIGHT },
  centerBox: { flex: 1, minHeight: GRAPH_HEIGHT, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 12 },
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
