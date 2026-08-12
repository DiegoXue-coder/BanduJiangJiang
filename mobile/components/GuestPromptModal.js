import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { IconX } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useAuthGate, GUEST_PROMPT_REASONS } from '../lib/authGate';
import LoginScreen from '../screens/LoginScreen';

// 续二十三访客模式：全局唯一一份注册引导弹层，App.js顶层挂一次。三个
// 触发点（我的/导入/AI相关入口）调用同一个requireAuth，这个组件只负责
// 展示。功能骨架（useAuthGate接线、直接复用LoginScreen而不重做表单、
// presentationStyle="pageSheet"的滑出交互）是2号在续二十三里先落地的
// 占位实现——这版在同一套骨架上补1号那份视觉规格（雾灰蓝卡片化的提示
// 徽标+圆形描边关闭按钮），不改交互结构本身。
export default function GuestPromptModal() {
  const theme = useTheme();
  const { reason, dismiss, handleLoggedIn } = useAuthGate();

  return (
    <Modal visible={!!reason} animationType="slide" onRequestClose={dismiss} presentationStyle="pageSheet">
      <View style={[styles.wrap, { backgroundColor: theme.bg }]}>
        <TouchableOpacity
          style={[styles.closeBtn, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
          onPress={dismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <IconX color={theme.textMuted} size={18} strokeWidth={2} />
        </TouchableOpacity>
        {!!reason && (
          <View style={styles.reasonBlock}>
            <View style={[styles.badge, { backgroundColor: theme.accentSoft, borderRadius: theme.radius }]}>
              <Text style={[styles.badgeText, { color: theme.accent }]}>登录后可用</Text>
            </View>
            <Text style={[styles.reasonText, { color: theme.textSecondary }]}>
              {GUEST_PROMPT_REASONS[reason] || '登录后才能使用这个功能'}
            </Text>
          </View>
        )}
        <LoginScreen onLoggedIn={handleLoggedIn} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  closeBtn: {
    position: 'absolute', top: 16, right: 16, zIndex: 10,
    width: 32, height: 32, borderRadius: 16, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  reasonBlock: { alignItems: 'center', paddingTop: 56, paddingHorizontal: 32 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, marginBottom: 10 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  reasonText: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
