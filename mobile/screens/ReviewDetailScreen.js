import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteHighlight } from '../lib/api';
import { useTheme } from '../theme';

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ReviewDetailScreen({ route, navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { item } = route.params;
  const isQa = item.type === 'qa';
  const [deleting, setDeleting] = useState(false);

  function confirmDelete() {
    Alert.alert('删除这条划线？', '删除后无法恢复', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            await deleteHighlight(item.book_id, item.id);
            navigation.goBack();
          } catch (e) {
            setDeleting(false);
            Alert.alert('删除失败', e.message || '请稍后重试');
          }
        },
      },
    ]);
  }

  function jumpToOriginal() {
    // 老数据没有 cfi_location 时，只能打开书、不能精确定位到那一段——
    // 不算 bug，是阶段五之前存的记录本来就没留这个字段。
    // jumpNonce 每次点击都不一样（哪怕连续点同一张卡片两次），确保 ReaderScreen
    // 那边的 goToLocation 真的会被触发，不会因为"跟上次的值一样"被 effect 跳过。
    navigation.navigate('书架', {
      screen: 'Reader',
      params: {
        bookId: item.book_id,
        initialCfi: item.cfi_location || undefined,
        jumpNonce: Date.now(),
      },
    });
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: theme.textOnAccent }]}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]} numberOfLines={1}>{item.book_title}</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={[
          styles.tag,
          { borderRadius: theme.radius, backgroundColor: isQa ? theme.accentSoft : theme.tagSoft },
        ]}>
          <Text style={[styles.tagText, { color: isQa ? theme.accent : theme.tag }]}>
            {isQa ? '问答' : '划线'}
          </Text>
        </View>

        <Text style={[styles.quoteText, { color: theme.text }]}>“{item.text}”</Text>

        {isQa && (item.turns || []).map((turn, idx) => (
          <View key={turn.id} style={idx > 0 ? [styles.turnDivider, { borderTopColor: theme.cardBorder }] : null}>
            <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>第{idx + 1}轮 · 提问</Text>
            <Text style={[styles.bodyText, { color: theme.text }]}>{turn.question}</Text>
            <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>回答</Text>
            <Text style={[styles.bodyText, { color: theme.text }]}>{turn.answer}</Text>
          </View>
        ))}

        {!!item.related_text && (
          <View style={[styles.relatedBox, { borderRadius: theme.radius, backgroundColor: theme.accentSoft }]}>
            <Text style={[styles.relatedText, { color: theme.accent }]}>
              🔗 与《{item.related_book_title}》里的"{item.related_text}"相关
            </Text>
          </View>
        )}

        <Text style={[styles.timeText, { color: theme.textMuted }]}>{formatTime(item.created_at)}</Text>

        <TouchableOpacity
          style={[styles.jumpBtn, { borderRadius: theme.radius, backgroundColor: theme.accent }]}
          onPress={jumpToOriginal}
        >
          <Text style={[styles.jumpBtnText, { color: theme.textOnAccent }]}>
            {item.cfi_location ? '📖 跳转到原文位置' : '📖 打开这本书（无法精确定位到原段落）'}
          </Text>
        </TouchableOpacity>

        {!isQa && (
          <TouchableOpacity
            style={[
              styles.deleteBtn,
              { borderRadius: theme.radius, backgroundColor: theme.cardBg, borderColor: theme.danger },
              deleting && styles.deleteBtnOff,
            ]}
            onPress={confirmDelete}
            disabled={deleting}
          >
            <Text style={[styles.deleteBtnText, { color: theme.danger }]}>{deleting ? '删除中…' : '🗑 删除这条划线'}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
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
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },

  content: { padding: 20 },

  tag: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, marginBottom: 14 },
  tagText: { fontSize: 12, fontWeight: '700' },

  quoteText: { fontSize: 17, lineHeight: 27, fontStyle: 'italic', marginBottom: 20 },

  sectionLabel: { fontSize: 12, fontWeight: '700', marginBottom: 6, marginTop: 12 },
  turnDivider: { marginTop: 16, paddingTop: 16, borderTopWidth: 0.5 },
  bodyText: { fontSize: 15, lineHeight: 24 },

  relatedBox: { marginTop: 20, padding: 12 },
  relatedText: { fontSize: 13, lineHeight: 19 },

  timeText: { fontSize: 12, marginTop: 20 },

  jumpBtn: { marginTop: 24, paddingVertical: 14, alignItems: 'center' },
  jumpBtnText: { fontSize: 14, fontWeight: '700' },

  deleteBtn: { marginTop: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5 },
  deleteBtnOff: { opacity: 0.5 },
  deleteBtnText: { fontSize: 14, fontWeight: '700' },
});
