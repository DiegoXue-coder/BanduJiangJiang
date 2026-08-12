import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert, Modal, Animated, ScrollView,
  Platform, useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import Svg, { Line, Rect, Defs, LinearGradient as SvgLinearGradient, Stop, Mask, G } from 'react-native-svg';
import { IconTrash, IconPlus } from '@tabler/icons-react-native';
import { getLibrary, importFile, importEpub, deleteMyBook } from '../lib/api';
import { useTheme } from '../theme';
import { FONTS } from '../fonts';
import KnownIssueNotice from '../components/KnownIssueNotice';

// 阶段十九：书架首页视觉换代——脱离阶段十"暖纸古风"的纵向列表卡片，
// 换成docs/设计稿/书架首页-未来感设计稿.html定的"深色精密网格+等宽
// 数据标签+3D coverflow横向书架"这套语言。下面几个常量/组件都是照抄
// 设计稿源码里的实际px/颜色数值实现的，不是凭"未来感""网格"这类文字
// 描述自己发挥的。

// 系统等宽字体栈——设计稿的--font-mono是系统字体（ui-monospace/SF Mono/
// Menlo/monospace），不是要单独打包的自定义字体文件，安卓上系统自带的
// 'monospace'和iOS的'Menlo'是最接近的系统等宽字体，不引入新字体资源。
const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const GRID_SIZE = 64; // 设计稿网格线间距 background-size:64px

// 网格背景：设计稿用CSS repeating-linear-gradient画横竖发丝线，顶部到
// 30%高度渐隐（mask-image）。RN没有CSS mask-image，用react-native-svg
// 的<Mask>+渐变矩形复刻同样的"顶部实、往下渐渐透明"效果，不是简化掉
// 这个细节——设计稿原话强调"网格线是故意做的，不是随手加的装饰"。
function GridBackground({ width, height, color }) {
  const cols = Math.ceil(width / GRID_SIZE) + 1;
  const rows = Math.ceil(height / GRID_SIZE) + 1;
  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
      <Defs>
        <SvgLinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#fff" stopOpacity="1" />
          <Stop offset="0.3" stopColor="#fff" stopOpacity="1" />
          <Stop offset="1" stopColor="#fff" stopOpacity="0" />
        </SvgLinearGradient>
        {/* 真机排查过：<Mask>不加maskUnits默认是objectBoundingBox（0~1
            相对坐标系），但里面的<Rect>用的是width/height这种绝对像素
            坐标，两个坐标系对不上，导致整个遮罩区域算出来是空的、什么
            都不显示（不是渐隐效果不对，是遮罩整体失效）。显式声明成
            userSpaceOnUse（绝对像素坐标系）才能跟Rect的坐标对上。 */}
        <Mask id="fadeMask" maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
          <Rect x="0" y="0" width={width} height={height} fill="url(#fade)" />
        </Mask>
      </Defs>
      <G mask="url(#fadeMask)">
        {Array.from({ length: rows }).map((_, i) => (
          <Line key={`h${i}`} x1="0" y1={i * GRID_SIZE} x2={width} y2={i * GRID_SIZE} stroke={color} strokeWidth={1} strokeOpacity={0.16} />
        ))}
        {Array.from({ length: cols }).map((_, i) => (
          <Line key={`v${i}`} x1={i * GRID_SIZE} y1="0" x2={i * GRID_SIZE} y2={height} stroke={color} strokeWidth={1} strokeOpacity={0.16} />
        ))}
      </G>
    </Svg>
  );
}

// 设计稿里每本书的封面是手绘挑的深色渐变，没有真实封面图可用——挑8组
// 同样调性的深色渐变当占位色板，按书本id轮流分配，保证同一本书每次
// 打开颜色都一样（不是每次随机跳变），也是设计稿"网格+等宽标签"这套
// 精密感语言的一部分，不是随手配的颜色。
const COVER_GRADIENTS = [
  ['#3a2e1a', '#20180d'],
  ['#1a2e28', '#0d201a'],
  ['#1a2530', '#0d1620'],
  ['#2e1c1a', '#20100d'],
  ['#22201a', '#15130d'],
  ['#1a1e2e', '#0d0f20'],
  ['#243a3a', '#132020'],
  ['#3a2438', '#201320'],
];
function gradientForBook(id) {
  const n = typeof id === 'number' ? id : String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return COVER_GRADIENTS[n % COVER_GRADIENTS.length];
}

const COVER_W = 104;
const COVER_H = 148;
const ITEM_GAP = 14; // 设计稿用-18px负margin做重叠，RN动画版改成正向间距，效果更稳定
const STRIDE = COVER_W + ITEM_GAP;

function CoverItem({ book, index, scrollX, onPress, onDeleted, theme }) {
  const isImported = book.source === 'imported';
  const hasProgress = !!book.current_cfi_location;
  const [c1, c2] = gradientForBook(book.id);
  // scrollX=index*STRIDE正好是这个item在屏幕正中间的那一刻——sidePad在
  // 两端加的留白刚好让scrollX=0时第0个item居中，代数上会跟这里的sidePad
  // 项抵消，这里不能重复加一次，加了会导致除了第0个之外的item永远算不出
  // "正对着屏幕中间"这个状态，动画会跟手指滑动对不上。
  const centerAt = index * STRIDE;
  const inputRange = [centerAt - STRIDE, centerAt, centerAt + STRIDE];
  const rotateY = scrollX.interpolate({ inputRange, outputRange: ['34deg', '0deg', '-34deg'], extrapolate: 'clamp' });
  const scale = scrollX.interpolate({ inputRange, outputRange: [0.86, 1, 0.86], extrapolate: 'clamp' });
  const brightness = scrollX.interpolate({ inputRange, outputRange: [0.62, 1, 0.62], extrapolate: 'clamp' });

  return (
    <Animated.View
      style={{
        width: COVER_W, marginRight: ITEM_GAP,
        transform: [{ perspective: 900 }, { scale }, { rotateY }],
      }}
    >
      <TouchableOpacity activeOpacity={0.85} onPress={onPress}>
        <Animated.View style={[styles.cfCover, { opacity: brightness }]}>
          <Svg style={StyleSheet.absoluteFill} width={COVER_W} height={COVER_H}>
            <Defs>
              <SvgLinearGradient id={`cg${book.id}`} x1="0" y1="0" x2="0.5" y2="1">
                <Stop offset="0" stopColor={c1} />
                <Stop offset="1" stopColor={c2} />
              </SvgLinearGradient>
            </Defs>
            <Rect x="0" y="0" width={COVER_W} height={COVER_H} fill={`url(#cg${book.id})`} />
          </Svg>
          <View style={styles.cfSpine} />
          {isImported && (
            <View style={styles.cfImportBadge}>
              <Text style={styles.cfImportBadgeText}>IMPORT</Text>
            </View>
          )}
          {isImported && (
            <TouchableOpacity
              style={styles.cfDeleteBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => confirmDeleteBook(book, onDeleted)}
            >
              <IconTrash color="rgba(255,255,255,.85)" size={13} strokeWidth={2} />
            </TouchableOpacity>
          )}
          <Text style={[styles.cfTitle, { fontFamily: FONTS.serifBold }]} numberOfLines={2}>{book.title}</Text>
        </Animated.View>
      </TouchableOpacity>
      <Text style={[styles.cfLabel, { color: theme.textMuted, fontFamily: MONO_FONT }]} numberOfLines={1}>
        {hasProgress ? '继续阅读' : '未开始'}
      </Text>
    </Animated.View>
  );
}

function AddTile({ theme, onPress, disabled }) {
  return (
    <TouchableOpacity
      style={[styles.addTile, { borderColor: theme.cardBorder }]}
      onPress={onPress}
      disabled={disabled}
    >
      {disabled ? <ActivityIndicator size="small" color={theme.textMuted} /> : <IconPlus color={theme.textMuted} size={20} strokeWidth={1.75} />}
    </TouchableOpacity>
  );
}

// 阶段十五（续，2026-08-06）：删除入口只在自己导入的书上出现——书架接口
// 本身已经按"预置书全体可见/导入的书只对导入者可见"过滤过，能出现在这个
// 列表里的imported书就是当前用户自己的，不需要再额外核对owner，后端
// /mine接口会再做一次权限校验兜底。
function confirmDeleteBook(book, onDeleted) {
  Alert.alert(
    '删除这本书？',
    `《${book.title}》会从书架移除，划线和阅读记录也会一并删除，无法恢复。`,
    [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive',
        onPress: async () => {
          try {
            await deleteMyBook(book.id);
            onDeleted();
          } catch (e) {
            Alert.alert('删除失败', e.message || '请稍后重试');
          }
        },
      },
    ],
  );
}

// 阶段十五（内部原型）：从系统文件选择器挑一个PDF/TXT/EPUB。PDF/TXT在
// 后端转换成EPUB后走跟预置书库完全一样的落地流程；EPUB直接走已经存在、
// 但一直没配手机端入口的/app/books/import。不做自定义进度条/取消这类
// 复杂交互——原型阶段选个文件、等一下、成功或看清楚报错，够用。
async function pickAndImportFile(setImporting, onDone) {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'text/plain', 'application/epub+zip'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return;

  const asset = result.assets[0];
  const ext = (asset.name || '').toLowerCase().split('.').pop();

  setImporting(true);
  try {
    if (ext === 'epub') {
      await importEpub(asset.uri, asset.name);
    } else {
      const mimeType = ext === 'pdf' ? 'application/pdf' : 'text/plain';
      const title = (asset.name || '').replace(/\.(pdf|txt)$/i, '');
      await importFile(asset.uri, asset.name, mimeType, title);
    }
    onDone();
  } catch (e) {
    Alert.alert('导入失败', e.message || '请稍后重试');
  } finally {
    setImporting(false);
  }
}

function CoverflowShelf({ books, theme, navigation, onDeleted }) {
  const { width: screenWidth } = useWindowDimensions();
  const sidePad = Math.max(22, (screenWidth - COVER_W) / 2);
  const scrollX = useRef(new Animated.Value(0)).current;
  return (
    <Animated.ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      decelerationRate="fast"
      snapToInterval={STRIDE}
      contentContainerStyle={{ paddingHorizontal: sidePad, paddingVertical: 6 }}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
      scrollEventThrottle={16}
    >
      {books.map((book, index) => (
        <CoverItem
          key={book.id}
          book={book}
          index={index}
          scrollX={scrollX}
          theme={theme}
          onPress={() => navigation.navigate('Reader', { bookId: book.id })}
          onDeleted={onDeleted}
        />
      ))}
    </Animated.ScrollView>
  );
}

export default function BookshelfScreen({ navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [books, setBooks]   = useState(null); // null = 加载中
  const [error, setError]   = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError('');
    try {
      const data = await getLibrary();
      setBooks(data);
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      if (isRefresh) setRefreshing(false);
    }
  }, []);

  // 每次进入这个tab都刷新一下（比如刚导入新书、或者从阅读页返回更新了进度）
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const presetBooks = useMemo(() => (books || []).filter((b) => b.source !== 'imported'), [books]);
  const importedBooks = useMemo(() => (books || []).filter((b) => b.source === 'imported'), [books]);

  if (books === null && !error) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      </SafeAreaView>
    );
  }

  if (error && books === null) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
        <View style={styles.centerBox}>
          <Text style={[styles.errorText, { color: theme.danger }]}>加载失败：{error}</Text>
          <TouchableOpacity style={[styles.retryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]} onPress={() => load()}>
            <Text style={[styles.retryText, { color: theme.textOnAccent }]}>重试</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      {/* 真机排查过一次：一开始传theme.cardBorder（本身就是浅灰，
          接近背景色）配低透明度，两层"浅"叠加根本看不见，越叠越淡不是
          越叠越淡化对比——设计稿原始做法是"深色+低透明度"，深色本身
          提供对比度，透明度只是把强度柔化，不是拿透明度去凑对比度。
          改用theme.text（跟设计稿--hairline:rgba(20,30,45,.12)里的
          深色同一个色相/明度级别）才是对的映射。 */}
      <GridBackground width={screenWidth} height={screenHeight} color={theme.text} />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 4, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={theme.accent} />}
      >
        <View style={styles.topBar}>
          <View>
            <Text style={[styles.brand, { color: theme.accent, fontFamily: MONO_FONT }]}>ChatBook</Text>
            <Text style={[styles.topTitle, { color: theme.text, fontFamily: FONTS.serifBold }]}>书架</Text>
          </View>
          <Text style={[styles.topMeta, { color: theme.textMuted, fontFamily: MONO_FONT }]}>
            {presetBooks.length} 本典籍{'\n'}{importedBooks.length} 本导入
          </Text>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <View style={styles.sectionTitleRow}>
              <View style={[styles.sectionDot, { backgroundColor: theme.accent }]} />
              <Text style={[styles.sectionTitle, { color: theme.text }]}>公版经典库</Text>
            </View>
            <Text style={[styles.sectionCount, { color: theme.textMuted, fontFamily: MONO_FONT }]}>官方精校 · {presetBooks.length}</Text>
          </View>
          {presetBooks.length > 0 && (
            <CoverflowShelf books={presetBooks} theme={theme} navigation={navigation} onDeleted={() => load()} />
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <View style={styles.sectionTitleRow}>
              <View style={[styles.sectionDot, { backgroundColor: theme.tag }]} />
              <Text style={[styles.sectionTitle, { color: theme.text }]}>我的导入</Text>
            </View>
            <Text style={[styles.sectionCount, { color: theme.textMuted, fontFamily: MONO_FONT }]}>仅自己可见 · {importedBooks.length}</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 22, paddingVertical: 6 }}>
            {importedBooks.map((book) => (
              <View key={book.id} style={{ width: COVER_W, marginRight: ITEM_GAP }}>
                <TouchableOpacity activeOpacity={0.85} onPress={() => navigation.navigate('Reader', { bookId: book.id })}>
                  <View style={styles.cfCover}>
                    <Svg style={StyleSheet.absoluteFill} width={COVER_W} height={COVER_H}>
                      <Defs>
                        <SvgLinearGradient id={`cgi${book.id}`} x1="0" y1="0" x2="0.5" y2="1">
                          <Stop offset="0" stopColor={gradientForBook(book.id)[0]} />
                          <Stop offset="1" stopColor={gradientForBook(book.id)[1]} />
                        </SvgLinearGradient>
                      </Defs>
                      <Rect x="0" y="0" width={COVER_W} height={COVER_H} fill={`url(#cgi${book.id})`} />
                    </Svg>
                    <View style={styles.cfSpine} />
                    <View style={styles.cfImportBadge}><Text style={styles.cfImportBadgeText}>IMPORT</Text></View>
                    <TouchableOpacity
                      style={styles.cfDeleteBtn}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      onPress={() => confirmDeleteBook(book, () => load())}
                    >
                      <IconTrash color="rgba(255,255,255,.85)" size={13} strokeWidth={2} />
                    </TouchableOpacity>
                    <Text style={[styles.cfTitle, { fontFamily: FONTS.serifBold }]} numberOfLines={2}>{book.title}</Text>
                  </View>
                </TouchableOpacity>
                <Text style={[styles.cfLabel, { color: theme.textMuted, fontFamily: MONO_FONT }]} numberOfLines={1}>
                  {book.current_cfi_location ? '继续阅读' : '未开始'}
                </Text>
              </View>
            ))}
            <AddTile theme={theme} disabled={importing} onPress={() => pickAndImportFile(setImporting, () => load())} />
          </ScrollView>
        </View>

        {presetBooks.length === 0 && importedBooks.length === 0 && (
          <View style={styles.centerBox}>
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>书架还是空的</Text>
          </View>
        )}
      </ScrollView>

      {/* 决策层这轮派发：导入过程之前只有头部按钮里一个不起眼的小转圈，
          用户完全不知道要等多久、能不能退出App。这里不做真实进度条——
          后端是一次性同步处理，没有分阶段进度可汇报，做百分比意义不大，
          改成诚实的加载状态说明+明确的"别退出"提示（KnownIssueNotice是
          阶段十四就有的已知问题场景化提示文案组件，本来就是给这种"没法
          精确但要说清楚"的场景用的）。这个Modal不可点击关闭，导入没结束
          之前用户只能等或者按系统返回键强制退出App——那种情况下就是
          "退出中断"，是下面这句警告文案想事先说清楚、而不是事后再处理
          的场景。 */}
      <Modal visible={importing} transparent animationType="fade">
        <View style={styles.importOverlay}>
          <View style={[styles.importCard, { backgroundColor: theme.cardBg, borderRadius: theme.radius, borderColor: theme.cardBorder }]}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.importTitle, { color: theme.text }]}>正在导入书籍…</Text>
            <KnownIssueNotice
              message="正在解析书籍内容，大文件可能需要1-2分钟"
              style={styles.importHint}
            />
            <Text style={[styles.importWarning, { color: theme.danger }]}>请勿退出App，退出会导致这次导入失败</Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  topBar: {
    paddingHorizontal: 22, paddingBottom: 18,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
  },
  brand: { fontSize: 10, letterSpacing: 2.2, textTransform: 'uppercase', fontWeight: '600' },
  topTitle: { fontSize: 27, fontWeight: '700', marginTop: 6 },
  topMeta: { fontSize: 10, textAlign: 'right', lineHeight: 15 },

  section: { marginBottom: 8 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    paddingHorizontal: 22, marginBottom: 12,
  },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionTitle: { fontSize: 14, fontWeight: '600' },
  sectionDot: { width: 6, height: 6, borderRadius: 3 },
  sectionCount: { fontSize: 10 },

  cfCover: {
    width: COVER_W, height: COVER_H,
    borderTopLeftRadius: 4, borderBottomLeftRadius: 4, borderTopRightRadius: 8, borderBottomRightRadius: 8,
    justifyContent: 'flex-end', padding: 10, overflow: 'hidden',
  },
  cfSpine: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 5,
    backgroundColor: 'rgba(0,0,0,.35)', borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
  },
  cfTitle: { fontSize: 13, fontWeight: '700', color: '#fff', lineHeight: 17 },
  cfLabel: { textAlign: 'center', marginTop: 10, fontSize: 9 },
  cfImportBadge: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,.35)', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 2,
  },
  cfImportBadgeText: { fontSize: 7, letterSpacing: 0.5, color: 'rgba(255,255,255,.85)', fontFamily: MONO_FONT },
  cfDeleteBtn: { position: 'absolute', top: 8, left: 8, padding: 2 },

  addTile: {
    width: COVER_W, height: COVER_H,
    borderWidth: 1, borderStyle: 'dashed',
    borderTopLeftRadius: 4, borderBottomLeftRadius: 4, borderTopRightRadius: 8, borderBottomRightRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },

  centerBox: { alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { fontSize: 14 },
  errorText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { fontWeight: '600' },

  importOverlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)', padding: 32,
  },
  importCard: { borderWidth: 1, padding: 24, alignItems: 'center', width: '100%' },
  importTitle: { fontSize: 16, fontWeight: '700', marginTop: 14 },
  importHint: { marginTop: 8 },
  importWarning: { fontSize: 13, fontWeight: '600', marginTop: 14, textAlign: 'center' },
});
