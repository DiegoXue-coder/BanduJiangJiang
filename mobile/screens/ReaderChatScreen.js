// 语音伴读对话原型 —— 这是转型前用来验证"划线→AI讲解→语音对话"链路是否跑得通的
// 原型页面，当时接的是微信读书网页版的上下文（/context/current），不是伴读讲讲
// 自己的书库。保留在这里供 WBS 阶段四（AI对话+语音）复用这套已经验证过的
// DeepSeek对话 + TTS + STT 管线，实际集成时需要把 loadBook() 改成读取自己书库的
// book_id 对应上下文，而不是继续依赖微信读书。暂时没有接入底部标签导航。
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, SafeAreaView, Alert,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';

// ── 配置：改成你的电脑局域网 IP ─────────────────────────────────────
const API_BASE = 'http://192.168.1.119:8002';

// ── 书名栏 ───────────────────────────────────────────────────────────
function BookBar({ title, author, chapter }) {
  if (!title) return null;
  return (
    <View style={styles.bookBar}>
      <Text style={styles.bookTitle} numberOfLines={1}>{title}</Text>
      <Text style={styles.bookMeta} numberOfLines={1}>
        {[author, chapter].filter(Boolean).join('  ·  ')}
      </Text>
    </View>
  );
}

// ── 消息气泡 ─────────────────────────────────────────────────────────
function Bubble({ role, text }) {
  const isUser = role === 'user';
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
      <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAI]}>
        {text}
      </Text>
    </View>
  );
}

// ── 打字动效 ─────────────────────────────────────────────────────────
function TypingBubble() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % 3), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={[styles.bubble, styles.bubbleAI]}>
      <Text style={[styles.bubbleText, styles.bubbleTextAI, styles.typingText]}>
        {['●○○', '○●○', '○○●'][frame]}
      </Text>
    </View>
  );
}

// ── 主屏幕 ────────────────────────────────────────────────────────────
export default function ReaderChatScreen() {
  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState('');
  const [status, setStatus]         = useState('连接中…');
  const [isThinking, setThinking]   = useState(false);
  const [isRecording, setRecording] = useState(false);
  const [ttsOn, setTtsOn]           = useState(true);
  const [bookCtx, setBookCtx]       = useState({
    bookTitle: '', author: '', chapterTitle: '',
    pageText: '', selection: '', userHighlights: [], popularHighlights: [],
  });

  const recordingRef = useRef(null);
  const soundRef     = useRef(null);
  const scrollRef    = useRef(null);

  useEffect(() => { loadBook(); }, []);

  // ── 拉取当前书本上下文 ──
  async function loadBook() {
    setStatus('连接中…');
    try {
      const res = await fetch(`${API_BASE}/context/current`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.bookTitle) {
        setBookCtx(prev => ({ ...prev, ...data }));
        setStatus(`已识别：${data.bookTitle}`);
        setTimeout(() => setStatus(''), 3000);
      } else {
        setStatus('未识别到正在阅读的书，请先在微信读书打开一本书');
      }
    } catch {
      setStatus('无法连接后端 — 请确认电脑和手机在同一 Wi-Fi');
    }
  }

  // ── 添加消息（最多保留 20 条）──
  function addMsg(role, text) {
    setMessages(prev => {
      const next = [...prev, { id: Date.now() + Math.random(), role, text }];
      return next.length > 20 ? next.slice(-20) : next;
    });
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
  }

  // ── TTS ──
  async function stopAudio() {
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => {});
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
  }

  async function speakText(text) {
    if (!ttsOn) return;
    await stopAudio();
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: `${API_BASE}/tts/play?text=${encodeURIComponent(text)}` },
        { shouldPlay: true },
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate(s => {
        if (s.didJustFinish) { sound.unloadAsync(); soundRef.current = null; }
      });
    } catch (e) {
      console.warn('[TTS]', e.message);
    }
  }

  // ── 发送问题 ──
  async function handleSend(question) {
    const q = question.trim();
    if (!q || isThinking) return;
    setInput('');
    addMsg('user', q);
    setThinking(true);
    try {
      const res = await fetch(`${API_BASE}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, context: bookCtx }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { answer } = await res.json();
      addMsg('assistant', answer);
      speakText(answer);
    } catch {
      setStatus('连接失败，请检查后端服务');
    } finally {
      setThinking(false);
    }
  }

  // ── 语音录制 ──
  async function toggleRecording() {
    if (isRecording) {
      setRecording(false);
      setStatus('识别中…');
      try {
        const rec = recordingRef.current;
        await rec.stopAndUnloadAsync();
        const uri = rec.getURI();
        recordingRef.current = null;
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

        const result = await FileSystem.uploadAsync(`${API_BASE}/transcribe`, uri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: { 'Content-Type': 'audio/m4a' },
        });
        const { text } = JSON.parse(result.body);
        if (text?.trim()) {
          setInput(text.trim());
          setStatus('识别完成 — 确认后点发送');
        } else {
          setStatus('未识别到内容，请重试');
        }
      } catch (e) {
        setStatus(`识别失败：${e.message}`);
      }
    } else {
      try {
        const { status: perm } = await Audio.requestPermissionsAsync();
        if (perm !== 'granted') {
          Alert.alert('需要麦克风权限', '请前往 设置 → 隐私与安全性 → 麦克风 → 开启伴读讲讲');
          return;
        }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY,
        );
        recordingRef.current = recording;
        setRecording(true);
        setStatus('录音中 — 再次点击停止');
      } catch (e) {
        setStatus(`无法启动录音：${e.message}`);
      }
    }
  }

  // ── 渲染 ──
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      {/* 顶栏 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={loadBook} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>↻</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>伴读讲讲</Text>
        <TouchableOpacity onPress={() => { setTtsOn(v => !v); stopAudio(); }} style={styles.ttsBtn}>
          <Text style={styles.ttsBtnText}>{ttsOn ? '🔊' : '🔇'}</Text>
        </TouchableOpacity>
      </View>

      {/* 书名栏 */}
      <BookBar title={bookCtx.bookTitle} author={bookCtx.author} chapter={bookCtx.chapterTitle} />

      {/* 消息区 */}
      <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.msgContent}>
        {messages.length === 0 && (
          <Text style={styles.emptyHint}>在微信读书打开一本书{'\n'}然后用语音或文字提问</Text>
        )}
        {messages.map(m => <Bubble key={m.id} role={m.role} text={m.text} />)}
        {isThinking && <TypingBubble />}
      </ScrollView>

      {/* 状态行 */}
      {!!status && <Text style={styles.status} numberOfLines={2}>{status}</Text>}

      {/* 输入区 */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.inputRow}>
          <TouchableOpacity
            style={[styles.voiceBtn, isRecording && styles.voiceBtnActive]}
            onPress={toggleRecording}
            disabled={isThinking}
          >
            <Text style={styles.voiceIcon}>{isRecording ? '⏹' : '🎤'}</Text>
          </TouchableOpacity>

          <TextInput
            style={styles.textInput}
            value={input}
            onChangeText={setInput}
            placeholder="输入问题…"
            placeholderTextColor="#a0a8bc"
            returnKeyType="send"
            onSubmitEditing={() => handleSend(input)}
            editable={!isThinking}
          />

          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || isThinking) && styles.sendBtnOff]}
            onPress={() => handleSend(input)}
            disabled={!input.trim() || isThinking}
          >
            <Text style={styles.sendText}>发送</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── 样式 ──────────────────────────────────────────────────────────────
const BLUE = '#4f8ef7';
const RED  = '#f7564f';

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: BLUE,
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.5 },
  refreshBtn:  { padding: 6 },
  refreshText: { color: 'rgba(255,255,255,0.85)', fontSize: 22, fontWeight: '300' },
  ttsBtn:      { padding: 6 },
  ttsBtnText:  { fontSize: 20 },

  bookBar: {
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dde3f0',
  },
  bookTitle: { fontSize: 14, fontWeight: '600', color: '#1a1a2e' },
  bookMeta:  { fontSize: 12, color: '#8a95b0', marginTop: 2 },

  messages:   { flex: 1 },
  msgContent: { padding: 16, paddingBottom: 8 },
  emptyHint: {
    textAlign: 'center', color: '#b0b8cc', fontSize: 13,
    marginTop: 48, lineHeight: 24,
  },

  bubble: { maxWidth: '85%', padding: 10, borderRadius: 14, marginBottom: 8 },
  bubbleUser: {
    backgroundColor: '#eef3ff', alignSelf: 'flex-end', borderBottomRightRadius: 4,
  },
  bubbleAI: {
    backgroundColor: '#fff', alignSelf: 'flex-start', borderBottomLeftRadius: 4,
    shadowColor: '#000', shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 }, shadowRadius: 3, elevation: 1,
  },
  bubbleText:     { fontSize: 14, lineHeight: 22 },
  bubbleTextUser: { color: '#2c3e6e' },
  bubbleTextAI:   { color: '#1a1a2e' },
  typingText:     { letterSpacing: 6, color: '#b0b8cc' },

  status: {
    textAlign: 'center', fontSize: 12, color: '#8a95b0',
    paddingHorizontal: 16, paddingVertical: 5,
  },

  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#dde3f0',
  },
  voiceBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center',
  },
  voiceBtnActive: { backgroundColor: RED },
  voiceIcon: { fontSize: 18 },

  textInput: {
    flex: 1, height: 44, paddingHorizontal: 12,
    backgroundColor: '#f4f6fb', borderRadius: 10,
    fontSize: 14, color: '#1a1a2e',
    borderWidth: 1.5, borderColor: '#dde3f0',
  },
  sendBtn: {
    height: 44, paddingHorizontal: 16, borderRadius: 10,
    backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnOff: { opacity: 0.45 },
  sendText:   { color: '#fff', fontSize: 14, fontWeight: '600' },
});
