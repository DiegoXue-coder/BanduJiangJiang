import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet,
  ActivityIndicator, RefreshControl, TouchableOpacity,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { getReview } from '../lib/api';
import { ReviewCard, formatTime } from '../components/ReviewCard';
import ConceptGraph from '../components/ConceptGraph';
import { useTheme } from '../theme';

const TABS = [
  { key: 'highlight', label: '划线' },
  { key: 'qa', label: '问答' },
  { key: 'related', label: '知识图谱' },
];

const EMPTY_HINT = {
  highlight: '还没有划线\n去书架翻开一本书试试吧',
  qa: '还没有提问记录\n去书架翻开一本书试试吧',
};

// 阶段八：划线/问答两个板块从扁平列表改成按书分卡片——把 items 按 book_id
// 分组。items 本来就是 created_at DESC 排好的，按遇到的先后顺序分组，
// 组内顺序、组之间的顺序（哪本书最近有活动排前面）都天然正确，不用再排序。
function groupByBook(items, type) {
  const groups = [];
  const indexByBook = new Map();
  for (const it of items) {
    if (it.type !== type) continue;
    let g = indexByBook.get(it.book_id);
    if (!g) {
      g = { book_id: it.book_id, book_title: it.book_title, items: [] };
      indexByBook.set(it.book_id, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups;
}

function BookCard({ group, onPress, theme }) {
  return (
    <TouchableOpacity
      style={[styles.bookCard, {
        backgroundColor: theme.cardBg, borderRadius: theme.radius,
        borderWidth: 0.5, borderColor: theme.cardBorder, shadowColor: theme.shadowColor,
      }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.bookCardLeft}>
        <Text style={[styles.bookCardTitle, { color: theme.text }]} numberOfLines={1}>{group.book_title}</Text>
        <Text style={[styles.bookCardMeta, { color: theme.textSecondary }]}>
          共 {group.items.length} 条 · 最近 {formatTime(group.items[0].created_at)}
        </Text>
      </View>
      <Text style={[styles.bookCardArrow, { color: theme.textMuted }]}>›</Text>
    </TouchableOpacity>
  );
}

export default function ReviewScreen({ navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems]     = useState(null); // null = 加载中
  const [error, setError]     = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab]         = useState('highlight');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError('');
    try {
      const data = await getReview();
      setItems(data);
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      if (isRefresh) setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const isBookshelfTab = tab === 'highlight' || tab === 'qa';

  const bookGroups = useMemo(() => {
    if (!items || !isBookshelfTab) return [];
    return groupByBook(items, tab);
  }, [items, tab, isBookshelfTab]);

  const tabBar = (
    <View style={[styles.tabRow, { backgroundColor: theme.cardBg, borderBottomColor: theme.cardBorder }]}>
      {TABS.map((t) => (
        <TouchableOpacity
          key={t.key}
          style={[
            styles.tabBtn,
            { borderRadius: theme.radius, backgroundColor: theme.bg, borderColor: theme.cardBorder },
            tab === t.key && { backgroundColor: theme.accent, borderColor: theme.accent },
          ]}
          onPress={() => setTab(t.key)}
        >
          <Text style={[styles.tabText, { color: tab === t.key ? theme.textOnAccent : theme.textSecondary }]}>{t.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  if (items === null && !error) {
    return (
      <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
        <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 14 }]}>
          <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>划线复盘</Text>
        </View>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      </SafeAreaView>
    );
  }

  if (error && items === null) {
    return (
      <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
        <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 14 }]}>
          <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>划线复盘</Text>
        </View>
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
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 14 }]}>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>划线复盘</Text>
      </View>
      {tabBar}
      {isBookshelfTab ? (
        <FlatList
          data={bookGroups}
          keyExtractor={(g) => `book-${g.book_id}`}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />
          }
          ListEmptyComponent={
            <View style={styles.centerBox}>
              <Text style={[styles.emptyText, { color: theme.textMuted }]}>{EMPTY_HINT[tab]}</Text>
            </View>
          }
          renderItem={({ item: group }) => (
            <BookCard
              group={group}
              theme={theme}
              onPress={() => navigation.navigate('ReviewBook', {
                bookTitle: group.book_title,
                tabLabel: TABS.find((t) => t.key === tab).label,
                items: group.items,
              })}
            />
          )}
        />
      ) : (
        <ConceptGraph />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '700' },

  tabRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabBtn: { paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1 },
  tabText: { fontSize: 13, fontWeight: '600' },

  listContent: { padding: 16, flexGrow: 1 },

  bookCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: 16, marginBottom: 12,
    shadowOpacity: 0.05, shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 1,
  },
  bookCardLeft: { flex: 1 },
  bookCardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  bookCardMeta: { fontSize: 12 },
  bookCardArrow: { fontSize: 22, marginLeft: 8 },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
  errorText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { fontWeight: '600' },
});
