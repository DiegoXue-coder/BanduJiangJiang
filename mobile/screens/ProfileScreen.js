import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../theme';
import { logout, getApiMode, setApiMode, resolveApiBase, describeApiBase } from '../lib/api';
import { useAuthGate } from '../lib/authGate';

// "我的"页面 —— 范围声明里确认的第三个底部入口。阶段十三加了真实登录，
// 这里补上退出登录；登出之后 App.js 会自动弹回登录页（logout()内部会
// 广播登录态变化，不需要这里自己处理导航跳转）。阶段十四加了Bug反馈入口
// ——"反馈问题"现在是"我的"tab自己的 stack 导航里"推入"的一个页面
// （BugReportScreen，见 App.js 的 ProfileStackScreen），不是本地 state
// 控制的 Modal：真机反馈过 Modal 版本安全区计算不准、也没法左滑退出，
// 换成推入式页面之后这两个问题都随 native-stack 自带的行为一起解决了。
//
// 续二十三访客模式："我的"是三个约定的注册引导触发点之一——访客进这个
// tab，直接弹注册引导（useFocusEffect每次这个tab重新获得焦点都会触发，
// 不是只在首次挂载时弹一次）。弹层被手动关掉之后，这里还要有个能重新
// 触发的按钮兜底，不能让访客卡在一个空白页面里出不去——具体视觉是1号的
// "访客模式下的书架/注册引导弹层视觉"那块任务，这里先给一版功能正确、
// 样式朴素的访客态占位。
// 开发者开关（隐藏入口：连点"我的"标题7下）——人在海外开发时手动选后端服务器。
// 两台服务器的账号/书/数据库互相独立，切换会清缓存并退出登录，详见 api.js setApiMode。
// 只在安卓显示：iOS 只有 Railway 一个入口，开关对它无效。
const API_MODE_OPTIONS = [
  { key: 'auto', label: '自动' },
  { key: 'tencent', label: '腾讯云' },
  { key: 'railway', label: '海外' },
];

function DevServerSwitch({ theme }) {
  const [mode, setMode] = React.useState(getApiMode());
  const [base, setBase] = React.useState('检测中…');

  React.useEffect(() => {
    let alive = true;
    resolveApiBase().then((b) => { if (alive) setBase(describeApiBase(b)); }).catch(() => {});
    return () => { alive = false; };
  }, [mode]);

  const choose = (next) => {
    if (next === mode) return;
    Alert.alert(
      '切换服务器？',
      '腾讯云和海外是两套独立的账号和书，不互通。切换后会清空本地缓存并退出登录，请随后完全关闭 App 再重新打开。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '切换',
          style: 'destructive',
          onPress: async () => {
            await setApiMode(next);
            setMode(next);
            Alert.alert('已切换', '请现在完全关闭 App（从最近任务里划掉），再重新打开。');
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.devBox, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
      <Text style={[styles.devTitle, { color: theme.text }]}>开发者 · 服务器</Text>
      <Text style={[styles.devHint, { color: theme.textMuted }]}>当前连接：{base}</Text>
      <View style={styles.devRow}>
        {API_MODE_OPTIONS.map((opt) => {
          const active = opt.key === mode;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.devBtn, { borderColor: active ? theme.accent : theme.cardBorder, borderRadius: theme.radius }]}
              onPress={() => choose(opt.key)}
            >
              <Text style={[styles.devBtnText, { color: active ? theme.accent : theme.text }]}>{opt.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function useDevMenu() {
  const [open, setOpen] = React.useState(false);
  const taps = React.useRef(0);
  const onTitlePress = React.useCallback(() => {
    if (Platform.OS === 'ios') return;
    taps.current += 1;
    if (taps.current >= 7) { taps.current = 0; setOpen((v) => !v); }
  }, []);
  return { open, onTitlePress };
}

export default function ProfileScreen({ navigation }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { loggedIn, requireAuth } = useAuthGate();
  const { open: devOpen, onTitlePress } = useDevMenu();

  useFocusEffect(
    React.useCallback(() => {
      if (!loggedIn) requireAuth('profile');
    }, [loggedIn, requireAuth]),
  );

  if (!loggedIn) {
    return (
      <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
        <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 14 }]}>
          <Text style={[styles.headerTitle, { color: theme.textOnAccent }]} onPress={onTitlePress}>我的</Text>
        </View>
        <View style={styles.centerBox}>
          <Text style={[styles.guestHint, { color: theme.textMuted }]}>
            当前是访客模式，登录后可以查看和管理你的账号
          </Text>
          <TouchableOpacity
            style={[styles.actionBtn, { borderColor: theme.accent, borderRadius: theme.radius }]}
            onPress={() => requireAuth('profile')}
          >
            <Text style={[styles.actionBtnText, { color: theme.accent }]}>去登录 / 注册</Text>
          </TouchableOpacity>
          {devOpen ? <DevServerSwitch theme={theme} /> : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 14 }]}>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]} onPress={onTitlePress}>我的</Text>
      </View>
      <View style={styles.centerBox}>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}
          onPress={() => navigation.navigate('BugReport')}
        >
          <Text style={[styles.actionBtnText, { color: theme.text }]}>反馈问题</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}
          onPress={() => navigation.navigate('FeedbackWall')}
        >
          <Text style={[styles.actionBtnText, { color: theme.text }]}>反馈墙</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}
          onPress={() => navigation.navigate('WebrtcAecTest')}
        >
          <Text style={[styles.actionBtnText, { color: theme.text }]}>AEC技术验证（内部）</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}
          onPress={() => logout()}
        >
          <Text style={[styles.actionBtnText, { color: theme.danger }]}>退出登录</Text>
        </TouchableOpacity>
        {devOpen ? <DevServerSwitch theme={theme} /> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  actionBtn: { borderWidth: 1, paddingHorizontal: 24, paddingVertical: 11, minWidth: 160, alignItems: 'center' },
  actionBtnText: { fontSize: 14, fontWeight: '600' },
  devBox: { borderWidth: 1, padding: 12, marginTop: 8, width: 260, gap: 8 },
  devTitle: { fontSize: 13, fontWeight: '700' },
  devHint: { fontSize: 12 },
  devRow: { flexDirection: 'row', gap: 8 },
  devBtn: { flex: 1, borderWidth: 1, paddingVertical: 8, alignItems: 'center' },
  devBtnText: { fontSize: 13, fontWeight: '600' },
  guestHint: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32, marginBottom: 8 },
});
