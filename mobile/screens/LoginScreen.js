import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { register, login } from '../lib/api';

// 阶段十三：最小可用多租户的注册/登录界面。用户名+密码，不接短信/邮箱
// 验证码、没有"忘记密码"入口——决策层拍板，测试阶段几个人的规模用不上
// 这些成本，忘了密码工程师直接去数据库改。
export default function LoginScreen({ onLoggedIn }) {
  const theme = useTheme();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === 'register';

  const getFriendlyErrorMessage = (message) => {
    const text = String(message || '');
    if (text.includes('Network request failed')) return '无法连接服务器，请检查网络后重试';
    return text || '出错了，请重试';
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setError('请输入用户名');
      return;
    }
    if (isRegister && trimmedUsername.length < 3) {
      setError('用户名至少3个字符');
      return;
    }
    if (!password) {
      setError('请输入密码');
      return;
    }
    if (isRegister && password.length < 6) {
      setError('密码至少6位');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      if (isRegister) {
        await register(trimmedUsername, password);
      } else {
        await login(trimmedUsername, password);
      }
      onLoggedIn();
    } catch (e) {
      setError(getFriendlyErrorMessage(e.message));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.centerBox}>
          <Text style={[styles.title, { color: theme.text }]}>沉光共读</Text>
          <Text style={[styles.enName, { color: theme.textMuted }]}>Dawn</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {isRegister ? '用户名至少3个字符，密码至少6位' : '登录'}
          </Text>

          <TextInput
            style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, color: theme.text, borderRadius: theme.radius }]}
            placeholder="用户名"
            placeholderTextColor={theme.textMuted}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, color: theme.text, borderRadius: theme.radius }]}
            placeholder="密码"
            placeholderTextColor={theme.textMuted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />

          {!!error && <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>}

          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }, submitting && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color={theme.textOnAccent} />
            ) : (
              <Text style={[styles.submitBtnText, { color: theme.textOnAccent }]}>
                {isRegister ? '注册' : '登录'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.switchModeBtn}
            onPress={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }}
          >
            <Text style={[styles.switchModeText, { color: theme.accent }]}>
              {isRegister ? '已有账号？去登录' : '没有账号？去注册'}
            </Text>
          </TouchableOpacity>

          <Text style={[styles.nameCallout, { color: theme.textMuted }]}>
            产品名字正在征集中，欢迎提建议
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  centerBox: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center', marginBottom: 2 },
  enName: { fontSize: 12, letterSpacing: 2, textAlign: 'center', marginBottom: 24 },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 28 },
  input: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, marginBottom: 12 },
  errorText: { fontSize: 13, marginBottom: 8, textAlign: 'center' },
  submitBtn: { paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { fontSize: 15, fontWeight: '700' },
  switchModeBtn: { marginTop: 18, alignItems: 'center' },
  switchModeText: { fontSize: 13 },
  nameCallout: { fontSize: 12, textAlign: 'center', marginTop: 32 },
});
