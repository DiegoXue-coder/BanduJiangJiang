import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, SafeAreaView, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getLibrary } from '../lib/api';

const BLUE = '#4f8ef7';

function BookCard({ book, onPress }) {
  const hasProgress = !!book.current_cfi_location;
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.coverPlaceholder}>
        <Text style={styles.coverInitial}>{book.title?.[0] || '书'}</Text>
      </View>
      <View style={styles.cardInfo}>
        <Text style={styles.cardTitle} numberOfLines={1}>{book.title}</Text>
        {!!book.author && (
          <Text style={styles.cardAuthor} numberOfLines={1}>{book.author}</Text>
        )}
        <Text style={styles.cardStatus}>{hasProgress ? '继续阅读' : '开始阅读'}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function BookshelfScreen({ navigation }) {
  const [books, setBooks]   = useState(null); // null = 加载中
  const [error, setError]   = useState('');
  const [refreshing, setRefreshing] = useState(false);

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

  if (books === null && !error) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={BLUE} />
        </View>
      </SafeAreaView>
    );
  }

  if (error && books === null) {
    return (
      <SafeAreaView style={styles.safe}>
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
        <Text style={styles.headerTitle}>书架</Text>
      </View>
      <FlatList
        data={books}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />
        }
        ListEmptyComponent={
          <View style={styles.centerBox}>
            <Text style={styles.emptyText}>书架还是空的</Text>
          </View>
        }
        renderItem={({ item }) => (
          <BookCard
            book={item}
            // 阅读器是阶段三的工作，现在还没做，先给个友好提示，不跳转到不存在的页面
            onPress={() => Alert.alert(item.title, '阅读器功能开发中，敬请期待')}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },
  header: {
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: BLUE,
  },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },

  listContent: { padding: 16, flexGrow: 1 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 14, padding: 12, marginBottom: 12,
    shadowColor: '#000', shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 1,
  },
  coverPlaceholder: {
    width: 52, height: 72, borderRadius: 6, marginRight: 12,
    backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center',
  },
  coverInitial: { color: '#fff', fontSize: 22, fontWeight: '700' },

  cardInfo: { flex: 1 },
  cardTitle:  { fontSize: 16, fontWeight: '600', color: '#1a1a2e' },
  cardAuthor: { fontSize: 13, color: '#8a95b0', marginTop: 2 },
  cardStatus: { fontSize: 12, color: BLUE, marginTop: 6, fontWeight: '600' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { color: '#b0b8cc', fontSize: 14 },
  errorText: { color: '#f7564f', fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: {
    marginTop: 16, paddingHorizontal: 20, paddingVertical: 10,
    backgroundColor: BLUE, borderRadius: 10,
  },
  retryText: { color: '#fff', fontWeight: '600' },
});
