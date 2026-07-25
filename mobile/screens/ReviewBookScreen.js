// 阶段八新增：书架式复盘的"某本书详情"页——ReviewScreen 点书本卡片进来，
// 展示这本书在当前 tab（划线/问答）下的具体内容列表。数据直接从上一页的
// navigation params 拿（ReviewScreen 已经一次性把全部数据拉回来了，这里
// 只是按 book_id 过滤出来的子集，不用再发一次网络请求，点开就是瞬间的事）。
import React from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ReviewCard } from '../components/ReviewCard';
import { useTheme } from '../theme';

export default function ReviewBookScreen({ route, navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { bookTitle, tabLabel, items } = route.params;

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
        <View style={styles.headerBtn} />
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
