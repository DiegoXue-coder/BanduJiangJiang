import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { IconX } from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useAuthGate, GUEST_PROMPT_REASONS } from '../lib/authGate';
import LoginScreen from '../screens/LoginScreen';

// 续二十三访客模式：全局唯一一份注册引导弹层，App.js顶层挂一次。三个
// 触发点（我的/导入/AI相关入口）调用同一个requireAuth，这个组件只负责
// 展示——具体视觉是1号的活（"访客模式下的书架/注册引导弹层视觉"），这版
// 是功能齐全但样式朴素的占位实现，不是最终稿。直接复用现成的LoginScreen
// （本来就是自带SafeAreaView的独立组件，不依赖是不是App唯一的顶层视图），
// 不用重新做一遍用户名/密码表单。
export default function GuestPromptModal() {
  const theme = useTheme();
  const { reason, dismiss, handleLoggedIn } = useAuthGate();

  return (
    <Modal visible={!!reason} animationType="slide" onRequestClose={dismiss} presentationStyle="pageSheet">
      <View style={[styles.wrap, { backgroundColor: theme.bg }]}>
        <TouchableOpacity style={styles.closeBtn} onPress={dismiss}>
          <IconX color={theme.textMuted} size={22} strokeWidth={2} />
        </TouchableOpacity>
        {!!reason && (
          <Text style={[styles.reasonText, { color: theme.textSecondary || theme.textMuted }]}>
            {GUEST_PROMPT_REASONS[reason] || '登录后才能使用这个功能'}
          </Text>
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
    width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
  },
  reasonText: {
    fontSize: 13, textAlign: 'center', paddingTop: 60, paddingHorizontal: 32,
  },
});
