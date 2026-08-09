import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, PermissionsAndroid, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
import { useTheme } from '../theme';
import { getTtsPlayUrl } from '../lib/api';

// WebRTC回声消除(AEC)安卓端技术验证spike（05-验收标准.md"技术验证spike"节，
// 2026-08-08决策层派发）。只是验证脚手架，不是正式功能，不接入真实通话/
// 打断逻辑，不做UI美化，跟阶段十七听书主线完全不共享文件。
//
// 验证方式：react-native-webrtc没有现成的"录制到文件"接口，业界测AEC效果
// 的标准做法是搭一对本机内部的RTCPeerConnection回环——不需要真实信令
// 服务器，offer/answer直接在同一个JS进程里互相设置。本地麦克风流经过
// echoCancellation处理后，pc2收到的remote track会由react-native-webrtc
// 自动路由到设备当前音频输出播放出来；同时另外触发一段TTS朗读播放，
// 强制走扬声器外放（不戴耳机），让麦克风真实拾取扬声器声音形成声学回声，
// 这才是AEC要处理的真实场景。判断依据：听TTS朗读有没有被回环延迟重复
// 播放一遍（回声的听感），没有就是AEC生效了。
//
// 第一版（戴耳机+不设置通话音频模式）真机测试反馈"没有效果"，查证到
// react-native-webrtc不会自动切换安卓音频会话到通话模式，"音频设备管理
// 留给应用自己做"（官方讨论区原话），必须用react-native-incall-manager
// 显式调用MODE_IN_COMMUNICATION，这是社区确认过的真实解法，见startLoopback
// 里的详细注释。
// 2026-08-09：决策层方案B（免提打断+静音开关）的第一步验证——免提打断要求
// App在朗读全程持续开麦监听，但不能把"检测到任何声音"都当成"要打断"（会被
// 环境噪音/电视声这类误触发），需要VAD（语音活动检测）这层过滤。这里先用
// 最简单的方案验证："检测有没有声音"退化成"检测音量够不够大"（能量阈值），
// 不引入额外的VAD算法库依赖——用户明确同意先验证这条最基础的路径，做不
// 准确再考虑升级成真正分析声音频率特征的VAD。
//
// 技术依据：react-native-webrtc的RTCPeerConnection.getStats()是对原生
// libwebrtc统计接口的直通封装（不是这个库自己模拟的），标准WebRTC统计里
// 音频统计对象自带audioLevel字段，W3C规范定义的取值范围是0.0~1.0——但
// 2026-08-09真机实测发现，这个库在安卓上返回的audioLevel明显不是这个
// 归一化范围：安静时读到0.0002~0.0003，正常说话时读到3000~5000，中间
// 差了大约一千万倍。不确定这是安卓原生libwebrtc统计接口本身在这个版本
// 上就没有按W3C的0~1归一化实现，还是这个库的桥接层漏做了归一化——没有
// 深究具体原因，因为不影响能不能用：安静和说话之间数量级差距巨大，
// 意味着哪怕不知道"标准"该是多少，只要阈值定在两者中间的安全区间，
// 用相对大小做判断依然完全可靠，这才是真正需要验证的东西，不是数值
// 本身要不要符合规范。
const VAD_POLL_INTERVAL_MS = 300;
// 阈值定在1.0：比实测安静时的最大值(0.0003)高3000多倍、比实测说话时
// 的最小值(3000+)低3000多倍，两头都留了巨大安全边际，容得下比"绝对
// 安静"更吵一些的正常环境噪音（比如轻微的环境声、翻书声）而不会误触发。
const VAD_SPEECH_THRESHOLD = 1.0;

export default function WebrtcAecTestScreen() {
  const theme = useTheme();
  const [status, setStatus] = useState('未开始');
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  const [audioLevel, setAudioLevel] = useState(null); // null=还没拿到过数据；数字=最近一次读到的audioLevel
  const [speaking, setSpeaking] = useState(false);
  const pc1Ref = useRef(null);
  const pc2Ref = useRef(null);
  const localStreamRef = useRef(null);
  const inCallManagerRef = useRef(null);
  const vadTimerRef = useRef(null);

  const log = useCallback((msg) => {
    console.log('[AEC测试]', msg);
    setLogs((prev) => [...prev.slice(-19), msg]);
  }, []);

  // 每300ms读一次pc1的统计数据，找音频相关的统计条目里的audioLevel字段。
  // 不同webrtc版本/统计条目类型可能叫法不完全一致，这里放宽成"只要这条
  // 统计里有audioLevel这个数字字段就用"，不写死只认某一种type，减少因为
  // 类型名对不上导致读不到数据的风险。
  function startVadPolling(pc) {
    stopVadPolling();
    vadTimerRef.current = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        let level = null;
        for (const report of stats.values()) {
          if (typeof report.audioLevel === 'number') {
            level = report.audioLevel;
            break;
          }
        }
        if (level !== null) {
          setAudioLevel(level);
          setSpeaking(level >= VAD_SPEECH_THRESHOLD);
        }
      } catch (e) {
        log(`读取音量统计失败: ${e.message}`);
      }
    }, VAD_POLL_INTERVAL_MS);
  }

  function stopVadPolling() {
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    setAudioLevel(null);
    setSpeaking(false);
  }

  // 页面被导航离开（比如直接返回上一页，没点"停止回环"）时清掉计时器，
  // 不然会一直在后台空转读stats——WebRTC连接本身没有做卸载清理（这是
  // 这个测试页原有的已知gap，不是这次新引入的，这次只补计时器这一项，
  // 不扩大这次改动的范围去顺带修连接清理）。
  useEffect(() => () => stopVadPolling(), []);

  async function startLoopback() {
    // react-native-webrtc必须用运行时require、不能在文件顶层静态import——
    // 库内部EventEmitter.js模块加载时会立刻执行
    // `new NativeEventEmitter(NativeModules.WebRTCModule)`，Expo Go里这个
    // 原生模块不存在，NativeEventEmitter收到undefined直接抛
    // Invariant Violation，而且是在App.js顶层import链路上同步触发的——
    // 不是等用户点进这个页面才崩，是整个App一启动就"App entry not found"，
    // 真机实测过（1号工程师2026-08-08反馈）。改成只有真按下"开始回环"这个
    // 按钮时才require，崩溃范围precise收窄到"点这个按钮"，Expo Go里其他
    // 页面（包括阶段十七听书）完全不受影响；真要触发原生WebRTC功能本来就
    // 需要走eas build的开发客户端，Expo Go点这个按钮本来就该失败，只是
    // 不该拖累整个App打不开。
    // 2026-08-10真机反馈：ListenScreen.js的方案B(免提打断)复用了同样的
    // 运行时require模式，暴露出一个这里也一直存在的真实bug——require()
    // 本身在Expo Go环境下就会同步抛"tried to access a native module that
    // doesn't exist"，如果require()调用留在try块外面，这个异常没人接住，
    // 表现成红屏"Uncaught Error"，不是优雅提示。运行时require确实解决了
    // "顶层import拖垮整个App"这个更严重的问题，但不代表require()调用
    // 本身就不会抛，两码事，这次把try块的起点往前挪到require()这一行，
    // 两个文件一起修，不能只修新发现问题的那一个。
    try {
      const { mediaDevices, RTCPeerConnection } = require('react-native-webrtc');
      // 同上，运行时require——InCallManager原生模块Expo Go里也不存在。
      const InCallManager = require('react-native-incall-manager').default;
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          { title: '麦克风权限', message: 'AEC技术验证需要访问麦克风', buttonPositive: '允许' },
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          setStatus('麦克风权限被拒绝');
          return;
        }
      }
      // 第一版测试用户真机反馈"回声消除没有效果"之后查证到的真实原因：
      // react-native-webrtc不会自动把安卓音频会话切到通话模式，"音频设备
      // 管理留给应用自己做"（react-native-webrtc官方讨论区原话）——不设置
      // AudioManager.MODE_IN_COMMUNICATION，系统级/WebRTC自带的回声消除都
      // 没有正确的参照信号可用，`echoCancellation:true`这个约束单独设置
      // 是不够的。这次改用react-native-incall-manager显式切换通话模式，
      // 这是社区确认过的真实解法，不是猜的。
      InCallManager.start({ media: 'audio' });
      InCallManager.setForceSpeakerphoneOn(true);
      inCallManagerRef.current = InCallManager;
      log('InCallManager已启动（通话音频模式+强制扬声器）');

      setStatus('获取麦克风流…');
      const stream = await mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = stream;
      log(`本地流获取成功，音轨数=${stream.getAudioTracks().length}`);

      const pc1 = new RTCPeerConnection({});
      const pc2 = new RTCPeerConnection({});
      pc1Ref.current = pc1;
      pc2Ref.current = pc2;

      stream.getTracks().forEach((track) => pc1.addTrack(track, stream));

      pc1.addEventListener('icecandidate', (e) => {
        if (e.candidate) pc2.addIceCandidate(e.candidate).catch((err) => log(`pc2加candidate失败: ${err.message}`));
      });
      pc2.addEventListener('icecandidate', (e) => {
        if (e.candidate) pc1.addIceCandidate(e.candidate).catch((err) => log(`pc1加candidate失败: ${err.message}`));
      });
      pc2.addEventListener('track', (e) => {
        log(`收到远端音轨（回环已连通），kind=${e.track.kind}`);
      });
      pc2.addEventListener('iceconnectionstatechange', () => {
        log(`ICE连接状态: ${pc2.iceConnectionState}`);
        if (pc2.iceConnectionState === 'connected' || pc2.iceConnectionState === 'completed') {
          setConnected(true);
          setStatus('回环已建立，可以说话+播放TTS测试了');
          startVadPolling(pc1); // 读pc1（发送本地麦克风流的那一端）的统计，不是pc2
        }
      });

      setStatus('协商中…');
      const offer = await pc1.createOffer({});
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(pc1.localDescription);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(pc2.localDescription);
      log('SDP协商完成');
    } catch (e) {
      log(`出错: ${e.message}`);
      setStatus(`失败: ${e.message}`);
    }
  }

  function stopLoopback() {
    stopVadPolling();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pc1Ref.current?.close();
    pc2Ref.current?.close();
    inCallManagerRef.current?.stop();
    localStreamRef.current = null;
    pc1Ref.current = null;
    pc2Ref.current = null;
    inCallManagerRef.current = null;
    setConnected(false);
    setStatus('已停止');
    log('回环已关闭，InCallManager已停止');
  }

  async function playTestTts() {
    try {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        {
          uri: getTtsPlayUrl(
            '这是一段用来测试回声消除效果的朗读音频，如果回环录音里听不到这段话，说明回声消除生效了。',
          ),
        },
        { shouldPlay: true },
      );
      log('TTS测试音频开始播放');
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          log('TTS测试音频播放完毕');
        }
      });
    } catch (e) {
      log(`播放TTS失败: ${e.message}`);
    }
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>WebRTC回声消除(AEC)测试</Text>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>
          技术验证spike，不是正式功能。这一版改成强制扬声器外放（不用戴耳机），因为AEC测的就是"外放的声音被麦克风拾到之后能不能被消掉"这个真实场景。点"开始回环"授权麦克风，再点"播放TTS测试音频"，判断方法：仔细听TTS这段朗读有没有像回声一样被延迟重复播了一遍（这是回环把麦克风原样录下的TTS又传回来放了一次）——如果只听到TTS清晰地播一遍、之后能听到你自己的说话声混进来，没有TTS的重复/拖尾，说明AEC生效了；如果TTS明显被重复播放/拖出回声尾巴，说明没生效。
        </Text>
        <Text style={[styles.status, { color: theme.text }]}>状态：{status}</Text>
        <TouchableOpacity
          style={[styles.btn, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}
          onPress={connected ? stopLoopback : startLoopback}
        >
          <Text style={[styles.btnText, { color: theme.text }]}>{connected ? '停止回环' : '开始回环'}</Text>
        </TouchableOpacity>
        {connected && (
          <View style={[styles.vadBox, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
            <Text style={[styles.vadTitle, { color: theme.text }]}>
              免提打断第一步验证：音量检测（VAD最简版）
            </Text>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              保持安静几秒，再正常说话几句，观察下面这个数字和状态会不会跟着变化——安静时应该是一个很小的数、开口说话应该明显跳高变成"检测到说话"。如果安静和说话时数字几乎没区别（一直是0或者一直很大），说明这条最基础的路径在这台设备上不work，需要换别的方案，不要往下继续做。
            </Text>
            <Text style={[styles.vadLevel, { color: speaking ? theme.accent : theme.textSecondary }]}>
              音量: {audioLevel === null ? '（还没数据）' : audioLevel.toFixed(4)}
            </Text>
            <Text style={[styles.vadStatus, { color: speaking ? theme.accent : theme.textSecondary }]}>
              {audioLevel === null ? '等待数据…' : speaking ? '● 检测到说话' : '○ 安静'}
            </Text>
          </View>
        )}
        <TouchableOpacity
          style={[
            styles.btn,
            { borderColor: theme.cardBorder, borderRadius: theme.radius, opacity: connected ? 1 : 0.4 },
          ]}
          onPress={playTestTts}
          disabled={!connected}
        >
          <Text style={[styles.btnText, { color: theme.text }]}>播放TTS测试音频</Text>
        </TouchableOpacity>
        <View style={styles.logBox}>
          {logs.map((l, i) => (
            <Text key={i} style={[styles.logLine, { color: theme.textSecondary }]}>
              {l}
            </Text>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13, lineHeight: 19 },
  status: { fontSize: 14, fontWeight: '600', marginTop: 8 },
  btn: { borderWidth: 1, paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  btnText: { fontSize: 15, fontWeight: '600' },
  logBox: { marginTop: 16, gap: 2 },
  logLine: { fontSize: 11, fontFamily: 'monospace' },
  vadBox: { borderWidth: 1, padding: 14, marginTop: 8, gap: 8 },
  vadTitle: { fontSize: 14, fontWeight: '700' },
  vadLevel: { fontSize: 22, fontWeight: '700', fontFamily: 'monospace', marginTop: 4 },
  vadStatus: { fontSize: 16, fontWeight: '600' },
});
