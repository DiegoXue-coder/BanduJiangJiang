import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, Image,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '../theme';
import { submitBugReport } from '../lib/api';

// 阶段十四：Bug反馈——相册选一张图+文字描述+提交，不做程序自动截屏（决策层
// 拍板范围，避免额外的相册以外权限/技术复杂度）。团队直接查数据库/图片
// 存储目录看，这里不做提交后的状态跟踪、不做自动分类。
//
// 用户真机反馈的两处修复：(1) 原来用 RN 的 <Modal> 弹出，SafeAreaView 在
// Modal 独立的原生视图层级里量出来的顶部安全区不准，标题跟状态栏时钟重叠
// ——改成挂在"我的"tab自己的 native-stack 导航里、正常"推入"的一个页面，
// 不再用 <Modal>，头部改成跟 ReviewDetailScreen/ReaderScreen 同款的写法
// （SafeAreaView 排除顶部 + 手动 insets.top 控制头部内边距）。
// (2) 用户希望能左滑边缘退出——这也是只有"推入的页面"才有的原生手势，
// <Modal> 从来不支持，改成 stack 页面后 iOS 端这个手势是 navigator 自带的，
// 不用额外写代码；同时保留"‹ 返回"按钮兼容 Android（Android 没有这个滑动
// 返回手势，需要能点的返回入口）。
export default function BugReportScreen({ navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [imageUri, setImageUri] = useState(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('没有相册权限', '需要相册权限才能选择截图，请在系统设置里允许访问照片');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
    });
    if (!result.canceled && result.assets?.[0]) {
      setImageUri(result.assets[0].uri);
    }
  };

  const handleSubmit = async () => {
    if (!imageUri) {
      Alert.alert('还没选图', '麻烦从相册选一张能说明问题的截图');
      return;
    }
    if (!description.trim()) {
      Alert.alert('还没写描述', '麻烦简单描述一下遇到的问题');
      return;
    }
    setSubmitting(true);
    try {
      await submitBugReport(description.trim(), imageUri);
      Alert.alert('已收到，谢谢你！', '你的建议对我们很珍贵，我们会认真看、尽快处理');
      navigation.goBack();
    } catch (e) {
      Alert.alert('提交失败', e.message || '请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 10 }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Text style={[styles.headerBtnText, { color: theme.textOnAccent }]}>‹ 返回</Text>
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.textOnAccent }]}>反馈问题</Text>
          <View style={styles.headerBtn} />
        </View>

        <View style={styles.body}>
          <Text style={[styles.introText, { color: theme.textSecondary }]}>
            感谢你愿意花时间体验、帮我们发现问题——作为最早一批用户，你的每一条建议我们都会认真看，能改的会尽快改。
          </Text>

          <TouchableOpacity
            style={[
              styles.imagePicker,
              { borderColor: theme.cardBorder, borderRadius: theme.radius, backgroundColor: theme.cardBg },
            ]}
            onPress={pickImage}
          >
            {imageUri ? (
              <Image source={{ uri: imageUri }} style={[styles.imagePreview, { borderRadius: theme.radius }]} />
            ) : (
              <Text style={[styles.imagePickerText, { color: theme.textSecondary }]}>点击从相册选一张截图，让我们更快看懂问题</Text>
            )}
          </TouchableOpacity>

          <TextInput
            style={[
              styles.descInput,
              { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, color: theme.text, borderRadius: theme.radius },
            ]}
            placeholder="说说你遇到了什么、或者有什么想法，怎么说都可以…"
            placeholderTextColor={theme.textMuted}
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
          />

          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }, submitting && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color={theme.textOnAccent} />
            ) : (
              <Text style={[styles.submitBtnText, { color: theme.textOnAccent }]}>提交</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4, paddingBottom: 10,
  },
  headerBtn: { minWidth: 64, paddingHorizontal: 12, paddingVertical: 6 },
  headerBtnText: { fontSize: 15 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  body: { flex: 1, padding: 16, gap: 14 },
  introText: { fontSize: 13, lineHeight: 20 },
  imagePicker: {
    height: 200, borderWidth: 1, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  imagePickerText: { fontSize: 14 },
  imagePreview: { width: '100%', height: '100%' },
  descInput: { borderWidth: 1, padding: 12, fontSize: 14, minHeight: 100 },
  submitBtn: { paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { fontSize: 15, fontWeight: '700' },
});
