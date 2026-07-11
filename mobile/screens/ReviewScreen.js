import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';

const BLUE = '#4f8ef7';

// 划线复盘页面 —— WBS阶段五的工作，这里先占位，保证导航结构（书架｜划线复盘｜我的）
// 按范围声明里确认的三个入口先搭起来，实际功能（读取 highlights + qa_history 按时间
// 倒序展示）留到阶段五再做。
export default function ReviewScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>划线复盘</Text>
      </View>
      <View style={styles.centerBox}>
        <Text style={styles.placeholderText}>功能开发中{'\n'}（WBS 阶段五）</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },
  header: { paddingHorizontal: 16, paddingVertical: 14, backgroundColor: BLUE },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: '#b0b8cc', fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
