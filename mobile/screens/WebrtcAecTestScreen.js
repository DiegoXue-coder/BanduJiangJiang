import React, { useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, PermissionsAndroid, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
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
// 测试者戴耳机对着手机说话，听回环声音里有没有掺进TTS朗读，就是AEC
// 有没有生效的直接判断依据。
export default function WebrtcAecTestScreen() {
  const theme = useTheme();
  const [status, setStatus] = useState('未开始');
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  const pc1Ref = useRef(null);
  const pc2Ref = useRef(null);
  const localStreamRef = useRef(null);

  const log = useCallback((msg) => {
    console.log('[AEC测试]', msg);
    setLogs((prev) => [...prev.slice(-19), msg]);
  }, []);

  async function startLoopback() {
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
    try {
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
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pc1Ref.current?.close();
    pc2Ref.current?.close();
    localStreamRef.current = null;
    pc1Ref.current = null;
    pc2Ref.current = null;
    setConnected(false);
    setStatus('已停止');
    log('回环已关闭');
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
          技术验证spike，不是正式功能。建议戴耳机测试：点"开始回环"授权麦克风后，回环建立会自动把处理后的麦克风声音从设备当前音频输出播放出来；再点"播放TTS测试音频"，对着手机说话，同时留意回环声音里有没有掺进TTS朗读——听不到就是AEC生效了。
        </Text>
        <Text style={[styles.status, { color: theme.text }]}>状态：{status}</Text>
        <TouchableOpacity
          style={[styles.btn, { borderColor: theme.cardBorder, borderRadius: theme.radius }]}
          onPress={connected ? stopLoopback : startLoopback}
        >
          <Text style={[styles.btnText, { color: theme.text }]}>{connected ? '停止回环' : '开始回环'}</Text>
        </TouchableOpacity>
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
});
