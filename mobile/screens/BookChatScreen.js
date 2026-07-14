// AI 对话面板（WBS 阶段四）——语音+文字问答管线跟 ReaderChatScreen.js 是
// 同一套（DeepSeek对话 + edge-tts播放 + SenseVoice转录），那边验证过的逻辑
// 原样搬过来，只是把"连微信读书网页版上下文"换成"传入自己书库的书本上下文"，
// 调的接口也从本机局域网地址换成走 lib/api.js 的正式鉴权。
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, SafeAreaView,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import {
  askQuestion, getTtsPlayUrl, transcribeAudio, saveQaHistory, getHighlights,
} from '../lib/api';

const BLUE = '#4f8ef7';
const RED  = '#f7564f';

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

export default function BookChatScreen({ route, navigation }) {
  const { bookId, bookTitle, author, chapterTitle, selection = '' } = route.params;

  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState('');
  const [status, setStatus]         = useState('');
  const [isThinking, setThinking]   = useState(false);
  const [isRecording, setRecording] = useState(false);
  const [ttsOn, setTtsOn]           = useState(true);
  const [style, setStyle]           = useState('simple'); // 'simple' 讲解 / 'socratic' 苏格拉底
  const [userHighlights, setUserHighlights] = useState([]);

  const recordingRef = useRef(null);
  const soundRef     = useRef(null);
  const scrollRef    = useRef(null);

  useEffect(() => {
    getHighlights(bookId)
      .then(rows => setUserHighlights(rows.map(r => r.highlighted_text).filter(Boolean).slice(0, 8)))
      .catch(() => {});
  }, [bookId]);

  function addMsg(role, text) {
    setMessages(prev => {
      const next = [...prev, { id: Date.now() + Math.random(), role, text }];
      return next.length > 20 ? next.slice(-20) : next;
    });
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
  }

  async function stopAudio() {
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => {});
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
  }

  // 静音不等于停止——静音是暂停（保留播放位置），取消静音要能从暂停的地方继续，
  // 不能每次切换都把声音销毁重建（之前那样写会导致"取消静音后完全没反应"）。
  async function pauseAudio() {
    if (soundRef.current) {
      await soundRef.current.pauseAsync().catch(() => {});
    }
  }

  async function resumeAudio() {
    if (soundRef.current) {
      await soundRef.current.playAsync().catch(() => {});
    }
  }

  function toggleTts() {
    setTtsOn((prev) => {
      const next = !prev;
      if (next) {
        resumeAudio();
      } else {
        pauseAudio();
      }
      return next;
    });
  }

  async function speakText(text) {
    await stopAudio(); // 换新的一条回答，旧的播放（不管是不是暂停中）先彻底清掉
    if (!ttsOn) return;
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: getTtsPlayUrl(text) },
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

  async function handleSend(question) {
    const q = question.trim();
    if (!q || isThinking) return;
    setInput('');
    addMsg('user', q);
    setThinking(true);
    try {
      const history = messages.slice(-10).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.text,
      }));
      const answer = await askQuestion({
        context: {
          bookTitle, author, chapterTitle,
          selection, pageText: '',
          userHighlights, popularHighlights: [],
        },
        question: q,
        style,
        history,
      });
      addMsg('assistant', answer);
      speakText(answer);
      saveQaHistory({ bookId, bookTitle, chapterTitle, question: q, answer, selection }).catch(() => {});
    } catch (e) {
      setStatus(`提问失败：${e.message}`);
    } finally {
      setThinking(false);
    }
  }

  async function toggleRecording() {
    console.log('[DEBUG] toggleRecording called, isRecording=', isRecording);
    if (isRecording) {
      setRecording(false);
      setStatus('识别中…');
      try {
        console.log('[DEBUG] recordingRef.current=', !!recordingRef.current);
        const rec = recordingRef.current;
        await rec.stopAndUnloadAsync();
        console.log('[DEBUG] stopAndUnloadAsync done');
        const uri = rec.getURI();
        console.log('[DEBUG] recording uri=', uri);
        recordingRef.current = null;
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

        console.log('[DEBUG] calling transcribeAudio...');
        const text = await transcribeAudio(uri, FileSystem.uploadAsync, FileSystem.FileSystemUploadType);
        console.log('[DEBUG] transcribeAudio returned:', JSON.stringify(text));
        if (text?.trim()) {
          setInput(text.trim());
          setStatus('识别完成 — 确认后点发送');
        } else {
          setStatus('未识别到内容，请重试');
        }
      } catch (e) {
        console.log('[DEBUG] toggleRecording (stop) error:', e && e.message, e && e.stack);
        setStatus(`识别失败：${e.message}`);
      }
    } else {
      try {
        const { status: perm } = await Audio.requestPermissionsAsync();
        console.log('[DEBUG] mic permission status:', perm);
        if (perm !== 'granted') {
          setStatus('需要麦克风权限，请到系统设置里开启');
          return;
        }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY,
        );
        recordingRef.current = recording;
        setRecording(true);
        setStatus('录音中 — 再次点击停止');
        console.log('[DEBUG] recording started');
      } catch (e) {
        console.log('[DEBUG] toggleRecording (start) error:', e && e.message, e && e.stack);
        setStatus(`无法启动录音：${e.message}`);
      }
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{bookTitle}</Text>
        <TouchableOpacity onPress={toggleTts} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>{ttsOn ? '🔊' : '🔇'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.styleToggleRow}>
        <TouchableOpacity
          style={[styles.styleToggleBtn, style === 'simple' && styles.styleToggleBtnActive]}
          onPress={() => setStyle('simple')}
        >
          <Text style={[styles.styleToggleText, style === 'simple' && styles.styleToggleTextActive]}>讲解</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.styleToggleBtn, style === 'socratic' && styles.styleToggleBtnActive]}
          onPress={() => setStyle('socratic')}
        >
          <Text style={[styles.styleToggleText, style === 'socratic' && styles.styleToggleTextActive]}>苏格拉底</Text>
        </TouchableOpacity>
      </View>

      {!!selection && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionText} numberOfLines={2}>“{selection}”</Text>
        </View>
      )}

      <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.msgContent}>
        {messages.length === 0 && (
          <Text style={styles.emptyHint}>
            {selection ? '针对这段文字提问，或者随便聊聊' : '用语音或文字提问'}
          </Text>
        )}
        {messages.map(m => <Bubble key={m.id} role={m.role} text={m.text} />)}
        {isThinking && <TypingBubble />}
      </ScrollView>

      {!!status && <Text style={styles.status} numberOfLines={2}>{status}</Text>}

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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6fb' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: BLUE,
  },
  headerBtn: { padding: 6, minWidth: 44 },
  headerBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '700' },

  styleToggleRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dde3f0',
  },
  styleToggleBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16,
    backgroundColor: '#f4f6fb', borderWidth: 1, borderColor: '#dde3f0',
  },
  styleToggleBtnActive: { backgroundColor: BLUE, borderColor: BLUE },
  styleToggleText: { fontSize: 13, color: '#5b6478', fontWeight: '600' },
  styleToggleTextActive: { color: '#fff' },

  selectionBar: {
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dde3f0',
  },
  selectionText: { fontSize: 13, color: '#5b6478', fontStyle: 'italic' },

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
