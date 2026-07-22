// AI 对话面板（WBS 阶段四）——语音+文字问答管线跟 ReaderChatScreen.js 是
// 同一套（DeepSeek对话 + edge-tts播放 + SenseVoice转录），那边验证过的逻辑
// 原样搬过来，只是把"连微信读书网页版上下文"换成"传入自己书库的书本上下文"，
// 调的接口也从本机局域网地址换成走 lib/api.js 的正式鉴权。
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, SafeAreaView, Alert,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import {
  streamAsk, getTtsPlayUrl, transcribeAudio, saveQaHistory, getHighlights, saveHighlight,
} from '../lib/api';

// 按中文/英文句末标点切句——流式回答边生成边攒 buffer，攒够一整句就送去TTS，
// 不用等全部回答生成完才开口。
const SENTENCE_END = /([。！？；\n])/;

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
  const { bookId, bookTitle, author, chapterTitle, selection = '', cfiRange = '' } = route.params;

  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState('');
  const [status, setStatus]         = useState('');
  const [isThinking, setThinking]   = useState(false);
  // 流式回答第一个字回来之前显示"打字中"动画，回来之后换成真正在长大的气泡，
  // 不是两个同时显示
  const [streamingId, setStreamingId] = useState(null);
  const [isRecording, setRecording] = useState(false);
  // isSpeaking 是给 UI 用的（要不要显示"打断"按钮）；ttsPlayingRef 是给
  // playNextInQueue 内部判断"现在能不能开始播下一句"用的，两个都要维护，
  // 一个是 state 一个是 ref，职责不一样，不能只留一个
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ttsOn, setTtsOn]           = useState(true);
  const [style, setStyle]           = useState('simple'); // 'simple' 讲解 / 'socratic' 苏格拉底
  const [userHighlights, setUserHighlights] = useState([]);
  // 长按选字进来的这段原文，可能已经在阅读器里划过线了——查一遍已有划线的
  // cfi_location，避免同一段文字重复存两条划线记录
  const [highlightSaved, setHighlightSaved] = useState(false);
  const [savingHighlight, setSavingHighlight] = useState(false);

  const recordingRef   = useRef(null);
  const soundRef       = useRef(null);
  const scrollRef      = useRef(null);
  const ttsQueueRef    = useRef([]);   // 按句切好、还没开始处理的文字队列
  const preparedRef    = useRef(null); // { text, sound } 提前加载好、还没播放的下一句
  const preparingRef   = useRef(false); // 正在预取的锁，防止并发重复预取
  const ttsPlayingRef  = useRef(false);
  const abortStreamRef = useRef(null); // streamAsk() 返回的取消函数

  useEffect(() => {
    getHighlights(bookId)
      .then(rows => {
        setUserHighlights(rows.map(r => r.highlighted_text).filter(Boolean).slice(0, 8));
        if (cfiRange && rows.some(r => r.cfi_location === cfiRange)) setHighlightSaved(true);
      })
      .catch(() => {});
  }, [bookId]);

  async function handleSaveHighlight() {
    if (!selection || !cfiRange || highlightSaved || savingHighlight) return;
    setSavingHighlight(true);
    try {
      await saveHighlight(bookId, { cfiLocation: cfiRange, highlightedText: selection });
      setHighlightSaved(true);
    } catch (e) {
      Alert.alert('划线保存失败', e.message || '请稍后重试');
    } finally {
      setSavingHighlight(false);
    }
  }

  function addMsg(role, text) {
    setMessages(prev => {
      const next = [...prev, { id: Date.now() + Math.random(), role, text }];
      return next.length > 20 ? next.slice(-20) : next;
    });
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
  }

  async function stopAudio() {
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    setIsSpeaking(false);
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => {});
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    // 提前加载好但还没播放的下一句音频也要一并释放，不然打断之后这份
    // 已经下载好的音频资源没人管，白占着
    if (preparedRef.current) {
      preparedRef.current.sound.unloadAsync().catch(() => {});
      preparedRef.current = null;
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

  // 流式回答按句切出来的每一句都过这里排队——上一句还没放完，新句子先进
  // 队列，不会互相打断；播完一句自动接下一句，直到队列清空。
  //
  // 2026-07-22：原来是"播完当前句才开始请求下一句"，请求+服务端合成+下载
  // 这段耗时全部发生在两句之间，听起来就是句子中间有停顿。改成"当前句一
  // 开始播放，就立刻在后台把下一句加载好（不播放）"——prefetchNext() 让
  // 下一句的加载时间跟当前句的播放时间重叠，播完直接无缝接上已经准备好的
  // 音频，不用现场再等一次网络请求。
  function enqueueTts(text) {
    if (!ttsOn || !text.trim()) return;
    ttsQueueRef.current.push(text.trim());
    if (ttsPlayingRef.current) {
      // 已经在放别的句子，趁这个空档把这句提前加载好
      prefetchNext();
    } else {
      playNextInQueue();
    }
  }

  // 提前把队列里下一句的音频加载好（只加载，不播放）。preparedRef 同一时间
  // 只准备一句——够用，队列纵深超过1句的情况很少见，没必要做成多级预取。
  //
  // preparingRef 是在这里补的锁：跟 playNextInQueue 同一个坑——"占位"必须在
  // await 之前同步完成，不然 flushSentences 一次性攒出好几句、连续同步调用
  // 好几次 enqueueTts 时，第二次调用会在第一次的 createAsync 还没返回、
  // preparedRef.current 还是空的这个窗口期里，误判"还没人在预取"，又并发
  // 发起一次加载，两次预取都往同一个 preparedRef 写，导致其中一句音频被
  // 静默吞掉、白白 shift 出队列却再也没人播放它。
  async function prefetchNext() {
    if (preparedRef.current || preparingRef.current || ttsQueueRef.current.length === 0) return;
    const text = ttsQueueRef.current.shift();
    preparingRef.current = true; // 占住位置，必须在下面的 await 之前
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: getTtsPlayUrl(text) },
        { shouldPlay: false },
      );
      preparedRef.current = { text, sound };
    } catch (e) {
      console.warn('[TTS 预取]', e.message); // 预取失败就跳过这一句，不影响后面排队的句子
    } finally {
      preparingRef.current = false;
    }
  }

  async function playNextInQueue() {
    if (ttsPlayingRef.current) return;

    // 先同步把要播的这一句"占"下来（要么拿走 preparedRef，要么从队列里
    // shift），紧接着立刻上锁 ttsPlayingRef——这两步中间不能插入任何
    // await。上一版的坑就在这：锁是在 await 加载完之后才上的，等待加载
    // 的这段时间里，如果 flushSentences 连续同步调用了好几次
    // enqueueTts，每次都会看到"还没在播"，各自都触发一次播放，好几句
    // 音频就这样同时播了出来（多个声音重叠的真正原因）。
    let pendingText, pendingSound = null;
    if (preparedRef.current) {
      ({ text: pendingText, sound: pendingSound } = preparedRef.current);
      preparedRef.current = null;
    } else if (ttsQueueRef.current.length > 0) {
      pendingText = ttsQueueRef.current.shift();
    } else {
      setIsSpeaking(false);
      return;
    }
    ttsPlayingRef.current = true; // 锁必须在这里、在任何 await 之前
    setIsSpeaking(true);

    let sound = pendingSound;
    if (!sound) {
      // 没有提前加载好的（比如第一句，或者上一句放得比预取还快），现场
      // 加载——退化成跟原来一样的行为，不会卡死
      try {
        ({ sound } = await Audio.Sound.createAsync(
          { uri: getTtsPlayUrl(pendingText) },
          { shouldPlay: false },
        ));
      } catch (e) {
        console.warn('[TTS]', e.message);
        ttsPlayingRef.current = false;
        playNextInQueue(); // 这一句加载失败就跳过，接着处理队列里下一句
        return;
      }
    }

    soundRef.current = sound;
    sound.setOnPlaybackStatusUpdate(s => {
      if (s.didJustFinish) {
        sound.unloadAsync();
        soundRef.current = null;
        ttsPlayingRef.current = false;
        playNextInQueue();
      }
    });
    sound.playAsync().catch(e => {
      console.warn('[TTS 播放]', e.message);
      ttsPlayingRef.current = false;
      playNextInQueue();
    });
    // 不等 playAsync 完成就着手预取下一句，让加载尽早跟播放重叠
    prefetchNext();
  }

  function handleSend(question) {
    const q = question.trim();
    if (!q || isThinking) return;
    setInput('');
    addMsg('user', q);
    setThinking(true);
    stopAudio(); // 新一轮提问，先把上一轮还没播完的音频/队列清掉

    const history = messages.slice(-10).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.text,
    }));

    let assistantMsgId = null;
    let fullText = '';
    let sentenceBuffer = '';

    // 把 buffer 里已经凑成整句的部分切出来送去TTS；isFinal时把剩下不满一句
    // 的尾巴也当作最后一句处理（流式结束时可能没有标点收尾）
    function flushSentences(isFinal) {
      for (;;) {
        const idx = sentenceBuffer.search(SENTENCE_END);
        if (idx === -1) break;
        enqueueTts(sentenceBuffer.slice(0, idx + 1));
        sentenceBuffer = sentenceBuffer.slice(idx + 1);
      }
      if (isFinal && sentenceBuffer.trim()) {
        enqueueTts(sentenceBuffer);
        sentenceBuffer = '';
      }
    }

    abortStreamRef.current = streamAsk(
      {
        context: {
          bookTitle, author, chapterTitle,
          selection, pageText: '',
          userHighlights, popularHighlights: [],
        },
        question: q,
        style,
        history,
      },
      {
        onDelta: (delta) => {
          fullText += delta;
          sentenceBuffer += delta;
          if (assistantMsgId === null) {
            assistantMsgId = Date.now() + Math.random();
            const id = assistantMsgId;
            setStreamingId(id);
            setMessages(prev => [...prev, { id, role: 'assistant', text: fullText }]);
          } else {
            const id = assistantMsgId;
            setMessages(prev => prev.map(m => (m.id === id ? { ...m, text: fullText } : m)));
          }
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 30);
          flushSentences(false);
        },
        onDone: (answer) => {
          flushSentences(true);
          setThinking(false);
          setStreamingId(null);
          abortStreamRef.current = null;
          saveQaHistory({ bookId, bookTitle, chapterTitle, question: q, answer, selection, cfiRange }).catch(() => {});
        },
        onError: (e) => {
          setStatus(`提问失败：${e.message}`);
          setThinking(false);
          setStreamingId(null);
          abortStreamRef.current = null;
        },
      },
    );
  }

  // 离开页面时中断还没结束的流式请求，顺带把还在播/还在排队的语音也停掉——
  // 之前只清了流式请求，没清音频，导致退出对话页之后 TTS 还在后台自己接
  // 着放完排队里剩下的句子，用户已经回到书架了耳朵里还在出声。
  useEffect(() => () => { abortStreamRef.current?.(); stopAudio(); }, []);

  // 手动打断：不管是还在流式生成文字、还是在放语音，点一下都立刻停，
  // 输入框/麦克风马上恢复可用，用户可以立刻打字或者录下一句话——不是
  // VAD 那种自动检测打断，是用户主动点按钮的"手动"打断。
  function handleInterrupt() {
    abortStreamRef.current?.();
    abortStreamRef.current = null;
    stopAudio();
    setThinking(false);
    setStreamingId(null);
    setStatus('');
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
          onPress={() => {
            setStyle('socratic');
            // 划线之后切到苏格拉底模式，输入框预填"讲解"方便直接点发送——
            // 第一轮苏格拉底本来就不看用户输的具体文字（用的是划线原文），
            // 这个词只是给用户一个能直接发送的默认值，不用自己想第一句话说啥。
            // 只在"对话刚开始+确实是从划线进来的+输入框还是空的"这个场景下
            // 才预填，已经聊了几轮或者没有划线原文的时候不动输入框。
            if (!input.trim() && messages.length === 0 && selection) {
              setInput('讲解');
            }
          }}
        >
          <Text style={[styles.styleToggleText, style === 'socratic' && styles.styleToggleTextActive]}>苏格拉底</Text>
        </TouchableOpacity>
      </View>

      {!!selection && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionText} numberOfLines={2}>“{selection}”</Text>
          {!!cfiRange && (
            <TouchableOpacity
              style={[styles.saveHighlightBtn, highlightSaved && styles.saveHighlightBtnDone]}
              onPress={handleSaveHighlight}
              disabled={highlightSaved || savingHighlight}
            >
              <Text style={styles.saveHighlightText}>
                {highlightSaved ? '✓ 已划线' : '📌 存为划线'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.msgContent}>
        {messages.length === 0 && (
          <Text style={styles.emptyHint}>
            {selection ? '针对这段文字提问，或者随便聊聊' : '用语音或文字提问'}
          </Text>
        )}
        {messages.map(m => <Bubble key={m.id} role={m.role} text={m.text} />)}
        {isThinking && streamingId === null && <TypingBubble />}
      </ScrollView>

      {!!status && <Text style={styles.status} numberOfLines={2}>{status}</Text>}

      {(isThinking || isSpeaking) && (
        <TouchableOpacity style={styles.interruptBar} onPress={handleInterrupt}>
          <Text style={styles.interruptBarText}>
            ⏹ {isThinking ? '打断生成' : '打断播放'}，说点别的
          </Text>
        </TouchableOpacity>
      )}

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
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#dde3f0',
  },
  selectionText: { flex: 1, fontSize: 13, color: '#5b6478', fontStyle: 'italic' },
  saveHighlightBtn: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    backgroundColor: '#fff3d6',
  },
  saveHighlightBtnDone: { backgroundColor: '#eef3ff' },
  saveHighlightText: { fontSize: 12, color: '#a35d00', fontWeight: '600' },

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

  interruptBar: {
    marginHorizontal: 16, marginBottom: 8, paddingVertical: 10,
    borderRadius: 10, backgroundColor: '#fff0ee',
    borderWidth: 1, borderColor: RED, alignItems: 'center',
  },
  interruptBarText: { color: RED, fontSize: 13, fontWeight: '600' },

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
