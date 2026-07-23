// 复盘页的单条卡片（划线/问答/关联主题都用这个），从 ReviewScreen 抽出来是
// 因为阶段八书架式重构后，ReviewScreen（书本列表）和新增的 ReviewBookScreen
// （某本书的具体内容列表）都要渲染同样的卡片，不想抄两份。
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

const BLUE = '#4f8ef7';
const AMBER = '#e0952f';

export function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReviewCard({ item, onPress }) {
  const isQa = item.type === 'qa';
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
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

      {isQa && item.turns && item.turns.length > 1 && (
        <Text style={styles.turnCountText}>共 {item.turns.length} 轮对话</Text>
      )}

      {!!item.related_text && (
        <View style={styles.relatedBox}>
          <Text style={styles.relatedText} numberOfLines={2}>
            🔗 与《{item.related_book_title}》里的"{item.related_text}"相关
          </Text>
        </View>
      )}

      <Text style={styles.timeText}>{formatTime(item.created_at)}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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
  turnCountText: { fontSize: 11, color: '#8a95b0', marginTop: 6, fontWeight: '600' },

  relatedBox: {
    marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: '#f2effa',
  },
  relatedText: { fontSize: 12, color: '#7a5fb0', lineHeight: 17 },

  timeText: { fontSize: 11, color: '#c0c6d6', marginTop: 8 },
});
