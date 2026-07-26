// 阶段十二：知识图谱 v1——替换"关联主题"扁平列表。
//
// 2026-07-26二次重做：原来的"d3-force扁平布局+2D平移缩放"方案被决策层
// 用效果图（HTML/Canvas原型，在浏览器里实测过手势）否掉，改成真正的
// 3D球面旋转——节点分布在一个虚拟球面上，拖动旋转、双指缩放；节点按
// 关联边的连通分量分"恒星"（每个分量里连接数最多的）和"行星"（其余），
// 默认只有恒星保持清晰，行星画得很小很暗当背景纹理（全局连线始终都在，
// 不是整个隐藏），双击带光环的恒星才会展开——它的行星被拉到恒星当前
// 屏幕位置周围的固定环上、变亮变大，同时镜头转到正对着这颗恒星、精确
// 居中（水平靠rotY、垂直靠rotX两个方向都解，不是只解水平那一个方向）。
// 再双击一次收起。单击（走react-native-svg原生onPress，不是手势库）
// 永远只弹来源详情卡片，不牵动镜头，跟双击的展开/聚焦互不冲突。
// 这一整套投影/连通分量/居中数学是先在一个独立HTML原型里用真实生产
// 数据反复验证过的，这里是照那份验证过的公式搬过来，不是重新猜的。
//
// 技术选型：球面投影+旋转是纯数学，不依赖d3-force——原来那个依赖已经
// 从package.json里删掉了。react-native-svg（阶段十一验证过）+
// react-native-gesture-handler（阶段三装的，App.js已包GestureHandlerRootView）
// + reanimated共享变量（阶段十验证过），三个库都是已经在用的，没有新增
// 原生依赖。所有节点的位置计算（球面投影、行星展开环、漂浮偏移）都写成
// worklet在UI线程跑，拖拽/缩放这种要求60fps连续更新的交互不会因为要
// 过JS线程桥而卡顿；只有单击弹卡片这个低频交互还是走JS线程的原生onPress。
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
  Pressable, ScrollView,
} from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';
import Animated, {
  useSharedValue, useDerivedValue, useAnimatedProps, withRepeat, withTiming, withDecay, Easing,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useFocusEffect } from '@react-navigation/native';
import { getConceptGraph } from '../lib/api';
import { useTheme } from '../theme';
import { FONTS } from '../fonts';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedSvgText = Animated.createAnimatedComponent(SvgText);

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 3.2;
const FOCUS_ZOOM = 1.9;

// 深色星空感背景是图谱区域自己固定的视觉风格，不跟随App的亮色/暗色主题
// 切换——星空氛围本身就该是暗的，跟着切成亮色反而破坏设计意图。
const SPACE_BG = '#12141F';
const STAR_COLOR = 'rgba(255,255,255,0.18)';
const EDGE_COLOR = 'rgb(200,195,220)';

// 节点颜色按思想流派分组（不是按书——一个概念可能横跨多本书），三个流派
// 目前够用，颜色数量卡在2-3个之内，避免每本书一个颜色导致的视觉噪音。
const CATEGORY_COLOR = {
  '道家': '#7FC9B8',
  '儒家': '#E0B15C',
  '墨家': '#A48FD1',
  '其他': '#8B96AC',
};

function nodeRadius(n) {
  'worklet';
  return 10 + Math.min(n.size, 8) * 2.5;
}

// 球面旋转+投影，加上"双击展开的行星贴在恒星旁边环绕"这条特殊分支——
// 单击/双击手势的命中测试、每个节点自己的位置动画，全部复用这同一个
// 函数，保证"眼睛看到哪、手指点哪"和"实际画在哪"永远是同一套计算，
// 不会出现两边算法不一致导致点不准的情况。
function projectNode(node, rotY, rotX, zoom, focusedStarId, cx, cy, R, byId) {
  'worklet';
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);
  function proj(ux, uy, uz) {
    const x1 = ux * cosY + uz * sinY;
    const z1 = -ux * sinY + uz * cosY;
    const y2 = uy * cosX - z1 * sinX;
    const z2 = uy * sinX + z1 * cosX;
    return { x: x1, y: y2, depth: z2 };
  }
  const isFocusedPlanet = !node.isStar && focusedStarId === node.starId;
  if (isFocusedPlanet) {
    const star = byId[node.starId];
    const sp = proj(star.ux, star.uy, star.uz);
    const starScale = 0.32 + 0.78 * ((sp.depth + 1) / 2);
    const starSx = cx + sp.x * R;
    const starSy = cy + sp.y * R;
    const starSr = nodeRadius(star) * starScale * 0.62;
    const ringR = starSr + 46;
    return {
      sx: starSx + Math.cos(node.planetAngle) * ringR,
      sy: starSy + Math.sin(node.planetAngle) * ringR * 0.9,
      sr: Math.max(9, nodeRadius(node) * 0.5),
      opacity: 1,
      depth: 1,
    };
  }
  const p = proj(node.ux, node.uy, node.uz);
  const ambient = !node.isStar;
  const sizeMul = ambient ? 0.34 : 1;
  const scale = (0.32 + 0.78 * ((p.depth + 1) / 2)) * sizeMul;
  const opacity = (0.12 + 0.85 * ((p.depth + 1) / 2)) * (ambient ? 0.4 : 1);
  return {
    sx: cx + p.x * R,
    sy: cy + p.y * R,
    sr: nodeRadius(node) * scale * 0.62,
    opacity,
    depth: p.depth,
  };
}

function normalizeAngleWorklet(a) {
  'worklet';
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

function hitTestWorklet(px, py, nodes, rotY, rotX, zoom, focusedStarId, cx, cy, R, byId) {
  'worklet';
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const p = projectNode(n, rotY, rotX, zoom, focusedStarId, cx, cy, R, byId);
    const dx = px - p.sx;
    const dy = py - p.sy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const hitR = Math.max(14, p.sr) + 6;
    if (d < hitR && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

// 数据准备：球面Fibonacci均匀分布 + 用真实关联边算连通分量分级出
// 恒星/行星 + 给每颗恒星的行星们分配环绕角度。只在图谱数据变化时算
// 一次（useMemo），不是每帧都重算。
//
// 这里特意只留下投影/手势真正要用到的字段（id/label/size/category+
// 算出来的球面坐标和恒星行星分级），不带每个节点原本的`sources`
// 数组——那里面是完整的划线原文+AI解释，累计起来是不小的一段中文
// 长文本。这份"精简版"节点会被reanimated worklet（每个节点自己的
// useDerivedValue、双击手势的命中测试）捕获闭包变量，worklet捕获
// 的数据要整份复制到UI线程自己的运行环境里，带着大段文本反复复制
// 是完全没必要的开销。详情弹窗要用的完整数据（含sources）单独留在
// 下面的fullById里，只在JS线程的点击回调里查一次，不进worklet。
function prepareGraph(nodes, edges) {
  if (!nodes || nodes.length === 0) return { nodes: [], edges: [], byId: {}, fullById: {} };
  const byId = {};
  const fullById = {};
  nodes.forEach((n) => { fullById[n.id] = n; });
  const prepared = nodes.map((n) => ({ id: n.id, label: n.label, size: n.size, category: n.category }));
  prepared.forEach((n) => { byId[n.id] = n; });

  const N = prepared.length;
  const golden = Math.PI * (3 - Math.sqrt(5));
  prepared.forEach((n, i) => {
    const y = N > 1 ? 1 - (i / (N - 1)) * 2 : 0;
    const rY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    n.ux = Math.cos(theta) * rY;
    n.uy = y;
    n.uz = Math.sin(theta) * rY;
  });

  const parent = {};
  prepared.forEach((n) => { parent[n.id] = n.id; });
  const find = (x) => {
    let v = x;
    while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; }
    return v;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const degree = {};
  prepared.forEach((n) => { degree[n.id] = 0; });
  const validEdges = edges.filter((e) => byId[e.source] && byId[e.target]);
  validEdges.forEach((e) => {
    union(e.source, e.target);
    degree[e.source] = (degree[e.source] || 0) + 1;
    degree[e.target] = (degree[e.target] || 0) + 1;
  });

  const componentMembers = {};
  prepared.forEach((n) => {
    const r = find(n.id);
    (componentMembers[r] = componentMembers[r] || []).push(n.id);
  });
  Object.keys(componentMembers).forEach((root) => {
    const members = componentMembers[root];
    const hub = members.reduce((best, id) => {
      if (best === null) return id;
      if (degree[id] > degree[best]) return id;
      if (degree[id] === degree[best] && byId[id].size > byId[best].size) return id;
      return best;
    }, null);
    members.forEach((id) => {
      byId[id].starId = hub;
      byId[id].isStar = id === hub;
      byId[id].hasPlanets = id === hub && members.length > 1;
    });
    const planetIds = members.filter((id) => id !== hub);
    planetIds.forEach((id, i) => {
      byId[id].planetAngle = (i / planetIds.length) * Math.PI * 2 - Math.PI / 2;
    });
  });

  return { nodes: prepared, edges: validEdges, byId, fullById };
}

// 每个节点的球面投影（projectNode）只在这一个useDerivedValue里算一次，
// 圆点/光环/标签三个子元素都从这同一份结果里取数，不用各自重新算一遍
// 三角函数——一个节点原来最多被独立投影3次，159个节点+44条边（每条边
// 又牵两个端点）在拖拽时每帧要跑的worklet次数相当可观，合并成算一次、
// 多处共享，直接把这部分计算量砍掉三分之二左右。
function GraphNodeGroup({ node, byId, rotY, rotX, zoom, focusedStarId, center, radius, onPressNode }) {
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  const duration = useMemo(() => 2600 + Math.random() * 1800, []);
  const amplitude = useMemo(() => 3 + Math.random() * 3, []);
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const projection = useDerivedValue(() => {
    'worklet';
    return projectNode(node, rotY.value, rotX.value, zoom.value, focusedStarId.value, center.x, center.y, radius, byId);
  });

  const circleProps = useAnimatedProps(() => {
    'worklet';
    const p = projection.value;
    const floatAngle = phase + t.value * Math.PI * 2;
    return {
      cx: p.sx + Math.cos(floatAngle) * amplitude,
      cy: p.sy + Math.sin(floatAngle) * amplitude,
      r: Math.max(1, p.sr),
      opacity: p.opacity,
    };
  });

  const haloProps = useAnimatedProps(() => {
    'worklet';
    const p = projection.value;
    const show = node.hasPlanets && focusedStarId.value !== node.id;
    return {
      cx: p.sx,
      cy: p.sy,
      r: Math.max(1, p.sr) + 4,
      opacity: show ? p.opacity * 0.55 : 0,
    };
  });

  const labelProps = useAnimatedProps(() => {
    'worklet';
    const p = projection.value;
    const ambientPlanet = !node.isStar && focusedStarId.value !== node.starId;
    // 恒星要非常正对镜头（depth>0.86，大致是球面正前方一小片）才显示标签，
    // 不是随便露一点脸就显示——119颗恒星里如果四分之一同时露脸+挂标签，
    // 手机屏幕这么小的画布上密密麻麻全部重叠在一起完全看不清（真机截图
    // 复现过），提到0.86之后同一时刻大概只有几颗最靠近正中的恒星挂标签。
    // 展开的行星走的是环绕分支（projectNode把它的depth强制记成1），
    // 不受这个提高后的门槛影响，永远清楚可读。
    const show = !ambientPlanet && p.depth > 0.86;
    return {
      x: p.sx,
      y: p.sy + p.sr + 12,
      opacity: show ? Math.min(0.9, p.opacity + 0.1) : 0,
    };
  });

  const color = CATEGORY_COLOR[node.category] || CATEGORY_COLOR['其他'];

  return (
    <>
      {node.hasPlanets && (
        <AnimatedCircle animatedProps={haloProps} fill="transparent" stroke={color} strokeWidth={1.5} />
      )}
      <AnimatedSvgText
        animatedProps={labelProps}
        fill="rgba(255,255,255,0.85)"
        fontSize={11}
        fontFamily={FONTS.sansRegular}
        textAnchor="middle"
      >
        {node.label}
      </AnimatedSvgText>
      {/* node是精简版（不带sources），详情弹窗要看完整来源，靠id去fullById查 */}
      <AnimatedCircle animatedProps={circleProps} fill={color} onPress={() => onPressNode(node.id)} />
    </>
  );
}

function GraphEdge({ edge, a, b, byId, rotY, rotX, zoom, focusedStarId, center, radius, onPress }) {
  // 两个端点各自的投影只算一次（useDerivedValue），下面两条Line（可见的
  // 细线+加宽的透明命中区域）共用同一份结果，不用各自重复算一遍三角函数。
  const projA = useDerivedValue(() => {
    'worklet';
    return projectNode(a, rotY.value, rotX.value, zoom.value, focusedStarId.value, center.x, center.y, radius, byId);
  });
  const projB = useDerivedValue(() => {
    'worklet';
    return projectNode(b, rotY.value, rotX.value, zoom.value, focusedStarId.value, center.x, center.y, radius, byId);
  });

  const visibleProps = useAnimatedProps(() => {
    'worklet';
    const pa = projA.value;
    const pb = projB.value;
    const avgDepth = (pa.depth + pb.depth) / 2;
    const bright = focusedStarId.value !== -1 && (a.id === focusedStarId.value || b.id === focusedStarId.value);
    const baseOp = bright ? 0.42 : 0.12;
    const op = avgDepth < -0.6 ? 0 : Math.max(0, baseOp * ((avgDepth + 1) / 2));
    return {
      x1: pa.sx, y1: pa.sy, x2: pb.sx, y2: pb.sy,
      strokeOpacity: op,
      strokeWidth: bright ? 1.4 : 0.8,
    };
  });
  // 加宽的透明命中区域只跟着同一对端点位置动，不带可见线那份透明度/
  // 粗细动画（不然strokeWidth会被两边worklet互相覆盖，命中区域也会跟着
  // 变细变窄）。单击它弹思维导图式的关联详情——跟双击展开恒星是完全
  // 不同的手势，走的还是react-native-svg原生onPress，不会被外层
  // GestureDetector的双击/拖拽手势抢走。
  const hitProps = useAnimatedProps(() => {
    'worklet';
    const pa = projA.value;
    const pb = projB.value;
    return { x1: pa.sx, y1: pa.sy, x2: pb.sx, y2: pb.sy };
  });
  return (
    <>
      <AnimatedLine animatedProps={visibleProps} stroke={EDGE_COLOR} />
      <AnimatedLine
        animatedProps={hitProps}
        stroke="transparent"
        strokeWidth={22}
        onPress={() => onPress(edge)}
      />
    </>
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

  const graph = useMemo(() => {
    if (!data) return { nodes: [], edges: [], byId: {}, fullById: {} };
    return prepareGraph(data.nodes, data.edges);
  }, [data]);

  const center = useMemo(
    () => (containerSize ? { x: containerSize.width / 2, y: containerSize.height / 2 } : { x: 0, y: 0 }),
    [containerSize],
  );
  const baseRadius = useMemo(
    () => (containerSize ? Math.min(containerSize.width, containerSize.height) * 0.34 : 0),
    [containerSize],
  );

  // 球面旋转/缩放/展开状态——全部是reanimated共享变量，直接在UI线程被
  // 手势更新、被每个节点的位置worklet读取，中间不经过JS线程，拖拽/双指
  // 缩放这种要求连续60fps更新的交互不会卡。
  const rotY = useSharedValue(0.4);
  const rotX = useSharedValue(-0.25);
  const zoom = useSharedValue(1);
  const savedZoom = useSharedValue(1);
  const focusedStarId = useSharedValue(-1);

  useEffect(() => {
    // 每次重新拉取图谱数据都回到默认视图，不残留上一次的旋转/缩放/展开状态。
    rotY.value = 0.4; rotX.value = -0.25; zoom.value = 1; savedZoom.value = 1; focusedStarId.value = -1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // react-native-gesture-handler + reanimated的babel插件通常会自动把
  // .onUpdate/.onEnd的回调识别成worklet，但这里显式写上'worklet'指令——
  // 不依赖自动识别，排除掉"回调没被正确worklet化导致UI线程抛错"这一类
  // 潜在问题，成本为零。
  const panGesture = useMemo(() => Gesture.Pan()
    .onUpdate((e) => {
      'worklet';
      rotY.value += e.changeX * 0.008;
      rotX.value = Math.max(-1.1, Math.min(1.1, rotX.value - e.changeY * 0.008));
    })
    .onEnd((e) => {
      'worklet';
      // 松手带一点惯性继续转，像真的在拨一个球，不是拖到哪停到哪。
      rotY.value = withDecay({ velocity: e.velocityX * 0.008, deceleration: 0.997 });
      rotX.value = withDecay({ velocity: -e.velocityY * 0.008, deceleration: 0.997, clamp: [-1.1, 1.1] });
    }), []);

  const pinchGesture = useMemo(() => Gesture.Pinch()
    .onUpdate((e) => {
      'worklet';
      zoom.value = Math.min(Math.max(savedZoom.value * e.scale, ZOOM_MIN), ZOOM_MAX);
    })
    .onEnd(() => {
      'worklet';
      savedZoom.value = zoom.value;
    }), []);

  // 双击：在带光环的恒星上=展开它的行星（拉到环上、变亮）+ 镜头转到正对
  // 着它、精确居中；再双击一次=收起。在空白处双击=收起当前展开的恒星。
  // 命中测试和渲染用的是同一个projectNode，点哪看哪不会对不上。
  const doubleTapGesture = useMemo(() => Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((e) => {
      'worklet';
      const hit = hitTestWorklet(
        e.x, e.y, graph.nodes, rotY.value, rotX.value, zoom.value, focusedStarId.value,
        center.x, center.y, baseRadius, graph.byId,
      );
      if (!hit) {
        if (focusedStarId.value !== -1) {
          focusedStarId.value = -1;
          zoom.value = withTiming(1, { duration: 380 });
        }
        return;
      }
      if (hit.hasPlanets) {
        if (focusedStarId.value === hit.id) {
          focusedStarId.value = -1;
          zoom.value = withTiming(1, { duration: 380 });
          return;
        }
        focusedStarId.value = hit.id;
      }
      // 把命中节点的单位向量转到正对镜头：先解水平（rotY让x1=0，
      // z1必为sqrt(ux²+uz²)正值），再用这个z1解垂直（rotX让y2=0）——
      // 两个方向都解才是真正居中，只解水平那一版真机上明显偏上/偏下。
      const mag = Math.sqrt(hit.ux * hit.ux + hit.uz * hit.uz) || 0.0001;
      const targetRotY = Math.atan2(-hit.ux, hit.uz);
      const targetRotX = Math.atan2(hit.uy, mag);
      const deltaY = normalizeAngleWorklet(targetRotY - rotY.value);
      rotY.value = withTiming(rotY.value + deltaY, { duration: 420 });
      rotX.value = withTiming(targetRotX, { duration: 420 });
      zoom.value = withTiming(FOCUS_ZOOM, { duration: 420 });
    }), [graph, center, baseRadius]);

  const composedGesture = useMemo(
    () => Gesture.Exclusive(doubleTapGesture, Gesture.Simultaneous(pinchGesture, panGesture)),
    [doubleTapGesture, pinchGesture, panGesture],
  );

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
    starsRef.current = Array.from({ length: 70 }, () => ({
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
      {containerSize && graph.nodes.length > 0 && (
        <GestureDetector gesture={composedGesture}>
          <Svg width={containerSize.width} height={containerSize.height}>
            {starsRef.current.map((s, i) => (
              <Circle key={`star-${i}`} cx={s.x} cy={s.y} r={s.r} fill={STAR_COLOR} />
            ))}
            {graph.edges.map((e, i) => {
              const a = graph.byId[e.source];
              const b = graph.byId[e.target];
              if (!a || !b) return null;
              return (
                <GraphEdge
                  key={`edge-${i}`}
                  edge={e} a={a} b={b} byId={graph.byId}
                  rotY={rotY} rotX={rotX} zoom={zoom} focusedStarId={focusedStarId}
                  center={center} radius={baseRadius}
                  onPress={setSelectedEdge}
                />
              );
            })}
            {graph.nodes.map((n) => (
              <GraphNodeGroup
                key={n.id}
                node={n} byId={graph.byId}
                rotY={rotY} rotX={rotX} zoom={zoom} focusedStarId={focusedStarId}
                center={center} radius={baseRadius}
                onPressNode={(id) => setSelectedNode(graph.fullById[id])}
              />
            ))}
          </Svg>
        </GestureDetector>
      )}

      {selectedNode && (
        <NodeDetailModal node={selectedNode} theme={theme} onClose={() => setSelectedNode(null)} />
      )}
      {selectedEdge && (
        <EdgeDetailModal
          edge={selectedEdge}
          nodeA={graph.fullById[selectedEdge.source]}
          nodeB={graph.fullById[selectedEdge.target]}
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
