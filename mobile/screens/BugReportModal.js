import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, Image,
  Modal, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '../theme';
import { submitBugReport } from '../lib/api';

// 阶段十四：Bug反馈——相册选一张图+文字描述+提交，不做程序自动截屏（决策层
// 拍板范围，避免额外的相册以外权限/技术复杂度）。团队直接查数据库/图片
// 存储目录看，这里不做提交后的状态跟踪、不做自动分类。
export default function BugReportModal({ visible, onClose }) {
  const theme = useTheme();
  const [imageUri, setImageUri] = useState(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setImageUri(null);
    setDescription('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

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
      Alert.alert('提交成功', '感谢反馈，我们会尽快处理');
      handleClose();
    } catch (e) {
      Alert.alert('提交失败', e.message || '请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.header, { borderBottomColor: theme.cardBorder }]}>
            <Text style={[styles.headerTitle, { color: theme.text }]}>反馈问题</Text>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
              <Text style={[styles.closeBtnText, { color: theme.textSecondary }]}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.body}>
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
                <Text style={[styles.imagePickerText, { color: theme.textSecondary }]}>点击从相册选一张截图</Text>
              )}
            </TouchableOpacity>

            <TextInput
              style={[
                styles.descInput,
                { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, color: theme.text, borderRadius: theme.radius },
              ]}
              placeholder="简单描述一下遇到的问题…"
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
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  closeBtn: { padding: 4 },
  closeBtnText: { fontSize: 16 },
  body: { flex: 1, padding: 16, gap: 14 },
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
