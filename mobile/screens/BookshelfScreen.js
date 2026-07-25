import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { getLibrary } from '../lib/api';
import { useTheme } from '../theme';

function BookCard({ book, onPress, theme }) {
  const hasProgress = !!book.current_cfi_location;
  return (
    <TouchableOpacity
      style={[styles.card, {
        backgroundColor: theme.cardBg, borderRadius: theme.radius,
        borderWidth: 0.5, borderColor: theme.cardBorder, shadowColor: theme.shadowColor,
      }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.coverPlaceholder, { borderRadius: theme.radius, backgroundColor: theme.accent }]}>
        <Text style={[styles.coverInitial, { color: theme.textOnAccent }]}>{book.title?.[0] || '书'}</Text>
      </View>
      <View style={styles.cardInfo}>
        <Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={1}>{book.title}</Text>
        {!!book.author && (
          <Text style={[styles.cardAuthor, { color: theme.textSecondary }]} numberOfLines={1}>{book.author}</Text>
        )}
        <Text style={[styles.cardStatus, { color: theme.accent }]}>{hasProgress ? '继续阅读' : '开始阅读'}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function BookshelfScreen({ navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 14 }]}>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>书架</Text>
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
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>书架还是空的</Text>
          </View>
        }
        renderItem={({ item }) => (
          <BookCard
            book={item}
            theme={theme}
            onPress={() => navigation.navigate('Reader', { bookId: item.id })}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '700' },

  listContent: { padding: 16, flexGrow: 1 },

  card: {
    flexDirection: 'row', alignItems: 'center',
    padding: 12, marginBottom: 12,
    shadowOpacity: 0.05, shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 1,
  },
  coverPlaceholder: {
    width: 52, height: 72, marginRight: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  coverInitial: { fontSize: 22, fontWeight: '700' },

  cardInfo: { flex: 1 },
  cardTitle:  { fontSize: 16, fontWeight: '600' },
  cardAuthor: { fontSize: 13, marginTop: 2 },
  cardStatus: { fontSize: 12, marginTop: 6, fontWeight: '600' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { fontSize: 14 },
  errorText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { fontWeight: '600' },
});
