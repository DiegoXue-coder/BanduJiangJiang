import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
} from 'react-native';

const BLUE = '#4f8ef7';
const AMBER = '#e0952f';

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ReviewDetailScreen({ route, navigation }) {
  const { item } = route.params;
  const isQa = item.type === 'qa';

  function jumpToOriginal() {
    // 老数据没有 cfi_location 时，只能打开书、不能精确定位到那一段——
    // 不算 bug，是阶段五之前存的记录本来就没留这个字段
    navigation.navigate('书架', {
      screen: 'Reader',
      params: { bookId: item.book_id, initialCfi: item.cfi_location || undefined },
    });
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{item.book_title}</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.tag, isQa ? styles.tagQa : styles.tagHighlight]}>
          <Text style={[styles.tagText, isQa ? styles.tagTextQa : styles.tagTextHighlight]}>
            {isQa ? '问答' : '划线'}
          </Text>
        </View>

        <Text style={styles.quoteText}>“{item.text}”</Text>

        {isQa && (
          <>
            <Text style={styles.sectionLabel}>提问</Text>
            <Text style={styles.bodyText}>{item.question}</Text>
            <Text style={styles.sectionLabel}>回答</Text>
            <Text style={styles.bodyText}>{item.answer}</Text>
          </>
        )}

        {!!item.related_text && (
          <View style={styles.relatedBox}>
            <Text style={styles.relatedText}>
              🔗 与《{item.related_book_title}》里的"{item.related_text}"相关
            </Text>
          </View>
        )}

        <Text style={styles.timeText}>{formatTime(item.created_at)}</Text>

        <TouchableOpacity style={styles.jumpBtn} onPress={jumpToOriginal}>
          <Text style={styles.jumpBtnText}>
            {item.cfi_location ? '📖 跳转到原文位置' : '📖 打开这本书（无法精确定位到原段落）'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: BLUE,
  },
  headerBtn: { padding: 6, minWidth: 60 },
  headerBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '700' },

  content: { padding: 20 },

  tag: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 14 },
  tagHighlight: { backgroundColor: '#fff3d6' },
  tagQa: { backgroundColor: '#e7f0ff' },
  tagText: { fontSize: 12, fontWeight: '700' },
  tagTextHighlight: { color: AMBER },
  tagTextQa: { color: BLUE },

  quoteText: {
    fontSize: 17, color: '#1a1a2e', lineHeight: 27, fontStyle: 'italic',
    marginBottom: 20,
  },

  sectionLabel: { fontSize: 12, color: '#8a95b0', fontWeight: '700', marginBottom: 6, marginTop: 12 },
  bodyText: { fontSize: 15, color: '#1a1a2e', lineHeight: 24 },

  relatedBox: {
    marginTop: 20, padding: 12, borderRadius: 10, backgroundColor: '#f2effa',
  },
  relatedText: { fontSize: 13, color: '#7a5fb0', lineHeight: 19 },

  timeText: { fontSize: 12, color: '#c0c6d6', marginTop: 20 },

  jumpBtn: {
    marginTop: 24, paddingVertical: 14, borderRadius: 12,
    backgroundColor: BLUE, alignItems: 'center',
  },
  jumpBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
