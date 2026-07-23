import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet,
  ActivityIndicator, RefreshControl, SafeAreaView, TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getReview } from '../lib/api';
import { ReviewCard, formatTime } from '../components/ReviewCard';

const BLUE = '#4f8ef7';

const TABS = [
  { key: 'highlight', label: '划线' },
  { key: 'qa', label: '问答' },
  { key: 'related', label: '关联主题' },
];

const EMPTY_HINT = {
  highlight: '还没有划线\n去书架翻开一本书试试吧',
  qa: '还没有提问记录\n去书架翻开一本书试试吧',
  related: '暂时没有检测到关联的问答\n多问几个问题，AI 会帮你留意呼应的地方',
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

function BookCard({ group, onPress }) {
  return (
    <TouchableOpacity style={styles.bookCard} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.bookCardLeft}>
        <Text style={styles.bookCardTitle} numberOfLines={1}>{group.book_title}</Text>
        <Text style={styles.bookCardMeta}>
          共 {group.items.length} 条 · 最近 {formatTime(group.items[0].created_at)}
        </Text>
      </View>
      <Text style={styles.bookCardArrow}>›</Text>
    </TouchableOpacity>
  );
}

export default function ReviewScreen({ navigation }) {
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

  const relatedItems = useMemo(() => {
    if (!items || isBookshelfTab) return [];
    return items.filter((i) => i.type === 'qa' && !!i.related_text);
  }, [items, isBookshelfTab]);

  const tabBar = (
    <View style={styles.tabRow}>
      {TABS.map((t) => (
        <TouchableOpacity
          key={t.key}
          style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]}
          onPress={() => setTab(t.key)}
        >
          <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  if (items === null && !error) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>划线复盘</Text>
        </View>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={BLUE} />
        </View>
      </SafeAreaView>
    );
  }

  if (error && items === null) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>划线复盘</Text>
        </View>
        <View style={styles.centerBox}>
          <Text style={styles.errorText}>加载失败：{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load()}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>划线复盘</Text>
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
              <Text style={styles.emptyText}>{EMPTY_HINT[tab]}</Text>
            </View>
          }
          renderItem={({ item: group }) => (
            <BookCard
              group={group}
              onPress={() => navigation.navigate('ReviewBook', {
                bookTitle: group.book_title,
                tabLabel: TABS.find((t) => t.key === tab).label,
                items: group.items,
              })}
            />
          )}
        />
      ) : (
        <FlatList
          data={relatedItems}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />
          }
          ListEmptyComponent={
            <View style={styles.centerBox}>
              <Text style={styles.emptyText}>{EMPTY_HINT[tab]}</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ReviewCard item={item} onPress={() => navigation.navigate('ReviewDetail', { item })} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },
  header: { paddingHorizontal: 16, paddingVertical: 14, backgroundColor: BLUE },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },

  tabRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dde3f0',
  },
  tabBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16,
    backgroundColor: '#f4f6fb', borderWidth: 1, borderColor: '#dde3f0',
  },
  tabBtnActive: { backgroundColor: BLUE, borderColor: BLUE },
  tabText: { fontSize: 13, color: '#5b6478', fontWeight: '600' },
  tabTextActive: { color: '#fff' },

  listContent: { padding: 16, flexGrow: 1 },

  bookCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 12,
    shadowColor: '#000', shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 1,
  },
  bookCardLeft: { flex: 1 },
  bookCardTitle: { fontSize: 16, color: '#1a1a2e', fontWeight: '700', marginBottom: 4 },
  bookCardMeta: { fontSize: 12, color: '#8a95b0' },
  bookCardArrow: { fontSize: 22, color: '#c0c6d6', marginLeft: 8 },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { color: '#b0b8cc', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  errorText: { color: '#f7564f', fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: {
    marginTop: 16, paddingHorizontal: 20, paddingVertical: 10,
    backgroundColor: BLUE, borderRadius: 10,
  },
  retryText: { color: '#fff', fontWeight: '600' },
});
