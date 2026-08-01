import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { logout } from '../lib/api';

// "我的"页面 —— 范围声明里确认的第三个底部入口。阶段十三加了真实登录，
// 这里补上退出登录；登出之后 App.js 会自动弹回登录页（logout()内部会
// 广播登录态变化，不需要这里自己处理导航跳转）。
export default function ProfileScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 14 }]}>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>我的</Text>
      </View>
      <View style={styles.centerBox}>
        <TouchableOpacity
          style={[styles.logoutBtn, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}
          onPress={() => logout()}
        >
          <Text style={[styles.logoutBtnText, { color: theme.danger }]}>退出登录</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  logoutBtn: { borderWidth: 1, paddingHorizontal: 24, paddingVertical: 11 },
  logoutBtnText: { fontSize: 14, fontWeight: '600' },
});
