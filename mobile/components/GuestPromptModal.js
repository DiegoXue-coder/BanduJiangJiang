import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { useTheme } from '../theme';

// 阶段十九：访客模式的注册引导弹层——只是呈现层组件，不含任何"什么时候
// 弹出来""访客能看到什么"的判断逻辑，那部分是决策层明确划给2号的访客
// 鉴权状态管理范围（docs/设计稿/新用户访客流程-草案.html只画了"在哪一步
// 拦截"这个流程图，没有这层视觉规格，也没有对应的isGuest全局状态可接——
// App.js目前是"没登录就整个App换成LoginScreen"这种根级别的门禁写法，
// 还没有"游客能先逛、碰到某个动作才拦"这套状态机，接入时机等2号把这层
// 做出来。这里先把弹层本身做成一个独立、只认props的展示组件，谁触发、
// 什么文案、点了"去注册"之后具体怎么跳转登录页，全部通过props从外面
// 传进来，不在组件内部猜测/硬编码。
//
// reason传什么文案由调用方决定，常见的几个触发点（"我的"/"导入"/AI相关
// 入口）预期文案不完全一样，这里不内置枚举，保持组件本身足够通用。
export default function GuestPromptModal({ visible, reason, onDismiss, onSignUp }) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
          <View style={[styles.badge, { backgroundColor: theme.accentSoft, borderRadius: theme.radius }]}>
            <Text style={[styles.badgeText, { color: theme.accent }]}>登录后可用</Text>
          </View>
          <Text style={[styles.title, { color: theme.text }]}>先注册一个账号</Text>
          <Text style={[styles.reason, { color: theme.textSecondary }]}>
            {reason || '登录后，划线和问答记录才会保存下来，换设备也能接着看。'}
          </Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]}
            onPress={onSignUp}
          >
            <Text style={[styles.primaryBtnText, { color: theme.textOnAccent }]}>去注册 / 登录</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dismissBtn} onPress={onDismiss}>
            <Text style={[styles.dismissBtnText, { color: theme.textMuted }]}>先随便看看</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)', padding: 32,
  },
  card: { borderWidth: 1, padding: 24, alignItems: 'center', width: '100%' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, marginBottom: 14 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  reason: { fontSize: 13.5, lineHeight: 20, textAlign: 'center', marginBottom: 20 },
  primaryBtn: { alignSelf: 'stretch', paddingVertical: 13, alignItems: 'center' },
  primaryBtnText: { fontSize: 15, fontWeight: '700' },
  dismissBtn: { marginTop: 10, paddingVertical: 8 },
  dismissBtnText: { fontSize: 13 },
});
