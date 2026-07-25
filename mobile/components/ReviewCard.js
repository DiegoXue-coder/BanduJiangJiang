// 复盘页的单条卡片（划线/问答/关联主题都用这个），从 ReviewScreen 抽出来是
// 因为阶段八书架式重构后，ReviewScreen（书本列表）和新增的 ReviewBookScreen
// （某本书的具体内容列表）都要渲染同样的卡片，不想抄两份。
// 阶段十：颜色/圆角全部换成 theme.js 的统一token，不再写死。
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

export function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReviewCard({ item, onPress }) {
  const theme = useTheme();
  const isQa = item.type === 'qa';
  return (
    <TouchableOpacity
      style={[styles.card, {
        backgroundColor: theme.cardBg, borderRadius: theme.radius,
        borderWidth: 0.5, borderColor: theme.cardBorder, shadowColor: theme.shadowColor,
      }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.cardTop}>
        <View style={[
          styles.tag,
          { borderRadius: theme.radius, backgroundColor: isQa ? theme.accentSoft : theme.tagSoft },
        ]}>
          <Text style={[styles.tagText, { color: isQa ? theme.accent : theme.tag }]}>
            {isQa ? '问答' : '划线'}
          </Text>
        </View>
        <Text style={[styles.bookTitle, { color: theme.textSecondary }]} numberOfLines={1}>{item.book_title}</Text>
      </View>

      <Text style={[styles.quoteText, { color: theme.text }]} numberOfLines={3}>“{item.text}”</Text>

      {isQa && !!item.answer && (
        <View style={[styles.answerBox, { borderTopColor: theme.cardBorder }]}>
          <Text style={[styles.answerText, { color: theme.textSecondary }]} numberOfLines={3}>{item.answer}</Text>
        </View>
      )}

      {isQa && item.turns && item.turns.length > 1 && (
        <Text style={[styles.turnCountText, { color: theme.textSecondary }]}>共 {item.turns.length} 轮对话</Text>
      )}

      {!!item.related_text && (
        <View style={[styles.relatedBox, { borderRadius: theme.radius, backgroundColor: theme.accentSoft }]}>
          <Text style={[styles.relatedText, { color: theme.accent }]} numberOfLines={2}>
            🔗 与《{item.related_book_title}》里的"{item.related_text}"相关
          </Text>
        </View>
      )}

      <Text style={[styles.timeText, { color: theme.textMuted }]}>{formatTime(item.created_at)}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 14, marginBottom: 12,
    shadowOpacity: 0.05, shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 1,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  tag: { paddingHorizontal: 7, paddingVertical: 2, marginRight: 8 },
  tagText: { fontSize: 11, fontWeight: '700' },
  bookTitle: { flex: 1, fontSize: 13, fontWeight: '600' },

  quoteText: { fontSize: 15, lineHeight: 22, fontStyle: 'italic' },

  answerBox: { marginTop: 8, paddingTop: 8, borderTopWidth: 0.5 },
  answerText: { fontSize: 13, lineHeight: 19 },
  turnCountText: { fontSize: 11, marginTop: 6, fontWeight: '600' },

  relatedBox: { marginTop: 8, padding: 8 },
  relatedText: { fontSize: 12, lineHeight: 17 },

  timeText: { fontSize: 11, marginTop: 8 },
});
