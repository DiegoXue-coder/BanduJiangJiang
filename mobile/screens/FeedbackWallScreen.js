import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Image, TouchableOpacity,
  ActivityIndicator, Modal, Pressable,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { listBugReports, getBugReportImageUrl } from '../lib/api';

// 反馈墙：任务#45，所有账号都能看到全部反馈（不只是自己提交的），互相
// 知道别人反馈了什么、有没有跟自己一样的问题。后端接口(GET /app/bug-reports)
// 阶段十四真机联调时就加了，一直只有管理用途没接前端——这次只补App内的
// 只读列表页，不改后端。不做状态跟踪/已解决标记/分类（决策层一贯拍板的
// "不做自动分类等复杂处理"范围，这里延续同一原则）。
function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function FeedbackWallScreen({ navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [previewUri, setPreviewUri] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await listBugReports();
      setReports(data || []);
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: theme.textOnAccent }]}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>反馈墙</Text>
        <View style={styles.headerBtn} />
      </View>

      {loading ? (
        <View style={styles.centerBox}><ActivityIndicator color={theme.accent} /></View>
      ) : error ? (
        <View style={styles.centerBox}>
          <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>
        </View>
      ) : reports.length === 0 ? (
        <View style={styles.centerBox}>
          <Text style={{ color: theme.textMuted }}>还没有人提交反馈</Text>
        </View>
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
              <View style={styles.cardHeader}>
                <Text style={[styles.username, { color: theme.text }]}>{item.username}</Text>
                <Text style={[styles.time, { color: theme.textMuted }]}>{formatTime(item.created_at)}</Text>
              </View>
              <Text style={[styles.description, { color: theme.textSecondary }]}>{item.description}</Text>
              <TouchableOpacity onPress={() => setPreviewUri(getBugReportImageUrl(item.id))}>
                <Image
                  source={{ uri: getBugReportImageUrl(item.id) }}
                  style={[styles.thumb, { borderRadius: theme.radius }]}
                  onError={() => {}}
                />
              </TouchableOpacity>
            </View>
          )}
        />
      )}

      <Modal visible={!!previewUri} transparent animationType="fade" onRequestClose={() => setPreviewUri(null)}>
        <Pressable style={styles.previewBackdrop} onPress={() => setPreviewUri(null)}>
          {previewUri && (
            <Image source={{ uri: previewUri }} style={styles.previewImage} resizeMode="contain" />
          )}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4, paddingBottom: 10,
  },
  headerBtn: { minWidth: 64, paddingHorizontal: 12, paddingVertical: 6 },
  headerBtnText: { fontSize: 15 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { fontSize: 14 },
  listContent: { padding: 16, gap: 12 },
  card: { borderWidth: 1, padding: 14, gap: 8 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  username: { fontSize: 14, fontWeight: '700' },
  time: { fontSize: 12 },
  description: { fontSize: 14, lineHeight: 20 },
  thumb: { width: '100%', height: 160 },
  previewBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '80%' },
});
