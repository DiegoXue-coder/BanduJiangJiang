import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';

const BLUE = '#4f8ef7';

// "我的"页面 —— 范围声明里确认的第三个底部入口，v1没有具体规划内容
// （单用户、不做注册登录），先占位保证导航结构完整。
export default function ProfileScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>我的</Text>
      </View>
      <View style={styles.centerBox}>
        <Text style={styles.placeholderText}>功能开发中</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },
  header: { paddingHorizontal: 16, paddingVertical: 14, backgroundColor: BLUE },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: '#b0b8cc', fontSize: 14 },
});
