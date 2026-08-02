import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

// 阶段十四：已知问题的场景化提示文案——通用模式，不是针对某一个功能单独
// 写一次。有些等待/加载态背后是已知的体验瑕疵（比如某个环节依赖人工触发、
// 某个识别偶尔较慢），暂时不打算修，但不该让用户对着一句语焉不详甚至有
// 误导性的文案干等——比如知识图谱空的时候之前写"多划线多提问AI会帮你梳理"，
// 暗示"你多用几次就会自动生成"，但实际上生成这一步是人工触发的，用户
// 怎么用都不会自动触发，这句话就是误导。与其让每个场景各自写一遍类似的
// 说明性文案，不如抽成一个组件，各处调用方只传 message，样式统一管理。
export default function KnownIssueNotice({ message, style }) {
  const theme = useTheme();
  return (
    <Text style={[styles.text, { color: theme.textMuted }, style]}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 13, lineHeight: 20, textAlign: 'center' },
});
