import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet,
  ActivityIndicator, RefreshControl, SafeAreaView, TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getReview } from '../lib/api';

const BLUE = '#4f8ef7';
const AMBER = '#e0952f';

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ReviewCard({ item }) {
  const isQa = item.type === 'qa';
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={[styles.tag, isQa ? styles.tagQa : styles.tagHighlight]}>
          <Text style={[styles.tagText, isQa ? styles.tagTextQa : styles.tagTextHighlight]}>
            {isQa ? '问答' : '划线'}
          </Text>
        </View>
        <Text style={styles.bookTitle} numberOfLines={1}>{item.book_title}</Text>
      </View>

      <Text style={styles.quoteText} numberOfLines={3}>“{item.text}”</Text>

      {isQa && !!item.answer && (
        <View style={styles.answerBox}>
          <Text style={styles.answerText} numberOfLines={3}>{item.answer}</Text>
        </View>
      )}

      <Text style={styles.timeText}>{formatTime(item.created_at)}</Text>
    </View>
  );
}

export default function ReviewScreen() {
  const [items, setItems]     = useState(null); // null = 加载中
  const [error, setError]     = useState('');
  const [refreshing, setRefreshing] = useState(false);

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
      <FlatList
        data={items}
        keyExtractor={(item) => `${item.type}-${item.id}`}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />
        }
        ListEmptyComponent={
          <View style={styles.centerBox}>
            <Text style={styles.emptyText}>还没有划线或提问{'\n'}去书架翻开一本书试试吧</Text>
          </View>
        }
        renderItem={({ item }) => <ReviewCard item={item} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },
  header: { paddingHorizontal: 16, paddingVertical: 14, backgroundColor: BLUE },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },

  listContent: { padding: 16, flexGrow: 1 },

  card: {
    backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 12,
    shadowColor: '#000', shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 1,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  tag: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, marginRight: 8 },
  tagHighlight: { backgroundColor: '#fff3d6' },
  tagQa: { backgroundColor: '#e7f0ff' },
  tagText: { fontSize: 11, fontWeight: '700' },
  tagTextHighlight: { color: AMBER },
  tagTextQa: { color: BLUE },
  bookTitle: { flex: 1, fontSize: 13, color: '#8a95b0', fontWeight: '600' },

  quoteText: { fontSize: 15, color: '#1a1a2e', lineHeight: 22, fontStyle: 'italic' },

  answerBox: {
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#f0f2f7',
  },
  answerText: { fontSize: 13, color: '#5b6478', lineHeight: 19 },

  timeText: { fontSize: 11, color: '#c0c6d6', marginTop: 8 },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { color: '#b0b8cc', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  errorText: { color: '#f7564f', fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: {
    marginTop: 16, paddingHorizontal: 20, paddingVertical: 10,
    backgroundColor: BLUE, borderRadius: 10,
  },
  retryText: { color: '#fff', fontWeight: '600' },
});
