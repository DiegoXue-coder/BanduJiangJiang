// 阶段八新增：书架式复盘的"某本书详情"页——ReviewScreen 点书本卡片进来，
// 展示这本书在当前 tab（划线/问答）下的具体内容列表。数据直接从上一页的
// navigation params 拿（ReviewScreen 已经一次性把全部数据拉回来了，这里
// 只是按 book_id 过滤出来的子集，不用再发一次网络请求，点开就是瞬间的事）。
import React, { useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { ReviewCard } from '../components/ReviewCard';
import { useTheme } from '../theme';
import { exportBookNotes } from '../lib/api';

// 沉淀文档导出v1（决策层2026-08-09派发任务2）：把这本书的划线+问答整理成
// Markdown文档。这个页面本来就是"某本书的划线/问答详情"，items里每条都带
// book_id（同一本书），直接取第一条的book_id调导出接口，不用再单独传参。
export default function ReviewBookScreen({ route, navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { bookTitle, tabLabel, items } = route.params;
  const [exporting, setExporting] = useState(false);
  const bookId = items[0]?.book_id;

  async function handleExport() {
    if (!bookId || exporting) return;
    setExporting(true);
    try {
      const { markdown, title } = await exportBookNotes(bookId);
      const safeName = (title || bookTitle || '书本').replace(/[\\/:*?"<>|]/g, '');
      const fileUri = `${FileSystem.cacheDirectory}${safeName}_笔记导出.md`;
      await FileSystem.writeAsStringAsync(fileUri, markdown, { encoding: 'utf8' });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, { mimeType: 'text/markdown', dialogTitle: '导出笔记' });
      } else {
        Alert.alert('导出完成', `文件已保存到：${fileUri}`);
      }
    } catch (e) {
      Alert.alert('导出失败', String(e?.message || e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: theme.textOnAccent }]}>‹ 返回</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: theme.textOnAccent }]} numberOfLines={1}>{bookTitle}</Text>
          <Text style={[styles.headerSubtitle, { color: theme.accentSoft }]}>{tabLabel} · 共{items.length}条</Text>
        </View>
        <TouchableOpacity onPress={handleExport} style={styles.headerBtn} disabled={!bookId || exporting}>
          {exporting
            ? <ActivityIndicator size="small" color={theme.textOnAccent} />
            : <Text style={[styles.headerBtnText, { color: theme.textOnAccent, opacity: bookId ? 1 : 0.4 }]}>导出</Text>}
        </TouchableOpacity>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => `${item.type}-${item.id}`}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <ReviewCard item={item} onPress={() => navigation.navigate('ReviewDetail', { item })} />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
  },
  headerBtn: { padding: 6, minWidth: 60 },
  headerBtnText: { fontSize: 15, fontWeight: '600' },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSubtitle: { fontSize: 11, marginTop: 2 },

  listContent: { padding: 16, flexGrow: 1 },
});
