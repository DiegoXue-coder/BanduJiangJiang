import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
import { useTheme } from '../theme';

// "我的"页面 —— 范围声明里确认的第三个底部入口，v1没有具体规划内容
// （单用户、不做注册登录），先占位保证导航结构完整。
export default function ProfileScreen() {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.accent }]}>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>我的</Text>
      </View>
      <View style={styles.centerBox}>
        <Text style={[styles.placeholderText, { color: theme.textMuted }]}>功能开发中</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { fontSize: 14 },
});
