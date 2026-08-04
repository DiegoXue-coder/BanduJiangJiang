import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import { IconUpload } from '@tabler/icons-react-native';
import { getLibrary, importFile } from '../lib/api';
import { useTheme } from '../theme';

function BookCard({ book, onPress, theme }) {
  const hasProgress = !!book.current_cfi_location;
  const isImported = book.source === 'imported';
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
        <View style={styles.cardTitleRow}>
          <Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={1}>{book.title}</Text>
          {isImported && (
            <View style={[styles.importedTag, { backgroundColor: theme.tagSoft, borderRadius: theme.radius }]}>
              <Text style={[styles.importedTagText, { color: theme.tag }]}>导入</Text>
            </View>
          )}
        </View>
        {!!book.author && (
          <Text style={[styles.cardAuthor, { color: theme.textSecondary }]} numberOfLines={1}>{book.author}</Text>
        )}
        <Text style={[styles.cardStatus, { color: theme.accent }]}>{hasProgress ? '继续阅读' : '开始阅读'}</Text>
      </View>
    </TouchableOpacity>
  );
}

// 阶段十五（内部原型）：从系统文件选择器挑一个PDF/TXT，后端转换成EPUB后
// 走跟预置书库完全一样的落地流程。不做自定义进度条/取消这类复杂交互——
// 原型阶段选个文件、等一下、成功或看清楚报错，够用（05-验收标准.md
// 阶段十五范围）。
async function pickAndImportFile(setImporting, onDone) {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'text/plain'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return;

  const asset = result.assets[0];
  const ext = (asset.name || '').toLowerCase().split('.').pop();
  const mimeType = ext === 'pdf' ? 'application/pdf' : 'text/plain';
  const title = (asset.name || '').replace(/\.(pdf|txt)$/i, '');

  setImporting(true);
  try {
    await importFile(asset.uri, asset.name, mimeType, title);
    onDone();
  } catch (e) {
    Alert.alert('导入失败', e.message || '请稍后重试');
  } finally {
    setImporting(false);
  }
}

export default function BookshelfScreen({ navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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
        <TouchableOpacity
          style={styles.importBtn}
          disabled={importing}
          onPress={() => pickAndImportFile(setImporting, () => load())}
        >
          {importing ? (
            <ActivityIndicator size="small" color={theme.textOnAccent} />
          ) : (
            <IconUpload color={theme.textOnAccent} size={22} strokeWidth={1.75} />
          )}
        </TouchableOpacity>
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
  header: {
    paddingHorizontal: 16, paddingVertical: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  importBtn: { padding: 4 },

  listContent: { padding: 16, flexGrow: 1 },

  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  importedTag: { paddingHorizontal: 6, paddingVertical: 2 },
  importedTagText: { fontSize: 10, fontWeight: '600' },

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
  cardTitle:  { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  cardAuthor: { fontSize: 13, marginTop: 2 },
  cardStatus: { fontSize: 12, marginTop: 6, fontWeight: '600' },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { fontSize: 14 },
  errorText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 24 },
  retryBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { fontWeight: '600' },
});
