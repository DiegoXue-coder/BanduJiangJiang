// AI 对话面板——阶段十改造：不再是独立跳转页面（route/navigation），改成
// ReaderScreen 里用 BottomSheetModal 弹出的内嵌面板，靠 props 直接传参、
// onClose 收起。语音+文字问答这条管线（DeepSeek对话 + edge-tts播放 +
// SenseVoice转录）本身没有变，只是外层容器和滚动组件换了。
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert,
} from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import {
  streamAsk, getTtsPlayUrl, transcribeAudio, saveQaHistory, getHighlights, saveHighlight,
} from '../lib/api';
import { useTheme } from '../theme';

// 按中文/英文句末标点切句——流式回答边生成边攒 buffer，攒够一整句就送去TTS，
// 不用等全部回答生成完才开口。
const SENTENCE_END = /([。！？；\n])/;

function Bubble({ role, text, theme }) {
  const isUser = role === 'user';
  return (
    <View style={[
      styles.bubble,
      { borderRadius: theme.radius, backgroundColor: isUser ? theme.accentSoft : theme.cardBg },
      isUser ? styles.bubbleUser : styles.bubbleAI,
      !isUser && { borderWidth: 0.5, borderColor: theme.cardBorder, shadowColor: theme.shadowColor },
    ]}>
      <Text style={[styles.bubbleText, { color: isUser ? theme.text : theme.text }]}>
        {text}
      </Text>
    </View>
  );
}

function TypingBubble({ theme }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % 3), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={[styles.bubble, styles.bubbleAI, { borderRadius: theme.radius, backgroundColor: theme.cardBg, borderWidth: 0.5, borderColor: theme.cardBorder }]}>
      <Text style={[styles.bubbleText, styles.typingText, { color: theme.textMuted }]}>
        {['●○○', '○●○', '○○●'][frame]}
      </Text>
    </View>
  );
}

export default function BookChatScreen({
  bookId, bookTitle, author, chapterTitle, selection = '', cfiRange = '', onClose,
}) {
  const theme = useTheme();
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

  // 排查"TTS完全没声音"查到的坑：没有任何地方显式设置过 playsInSilentModeIOS，
  // 手机physical静音开关打开时 playAsync() 正常resolve但完全没声音、不报错。
  // 面板一挂载就设一次，不依赖录音功能有没有被用过。
  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
  }, []);

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
  // 当前句一开始播放，就立刻在后台把下一句加载好（不播放）——prefetchNext()
  // 让下一句的加载时间跟当前句的播放时间重叠，播完直接无缝接上已经准备好的
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
  // preparingRef 是这里补的锁：占位必须在 await 之前同步完成，不然
  // flushSentences 一次性攒出好几句、连续同步调用好几次 enqueueTts 时，
  // 第二次调用会在第一次的 createAsync 还没返回、preparedRef.current 还是
  // 空的这个窗口期里，误判"还没人在预取"，又并发发起一次加载，两次预取都
  // 往同一个 preparedRef 写，导致其中一句音频被静默吞掉、白白 shift 出
  // 队列却再也没人播放它。
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
    // await。锁必须在 await 加载之前同步上，不然等待加载的这段时间里，
    // 如果 flushSentences 连续同步调用了好几次 enqueueTts，每次都会看到
    // "还没在播"，各自都触发一次播放，好几句音频就这样同时播了出来。
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
    // 语音转文字发送这条路径专属的坑：toggleRecording 识别完之后会
    // setStatus('识别完成 — 确认后点发送')，发送本身原来没有清掉这条提示——
    // 打字发送从来没设过 status，所以看不出问题；语音发送之后这行字会一直
    // 挂在输入框下面，容易被当成"发送没成功/输入框没清空"。
    setStatus('');
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

  // 面板卸载（用户收起/关闭）时中断还没结束的流式请求，顺带把还在播/还在
  // 排队的语音也停掉——不然收起面板之后 TTS 还在后台自己接着放完排队里
  // 剩下的句子。
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
    if (isRecording) {
      setRecording(false);
      setStatus('识别中…');
      try {
        const rec = recordingRef.current;
        await rec.stopAndUnloadAsync();
        const uri = rec.getURI();
        recordingRef.current = null;
        // 顺带保留 playsInSilentModeIOS: true——只关录音模式，别把这个字段
        // 隐式重置掉，不然录过一次音之后TTS播放又会看手机静音开关脸色
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });

        const text = await transcribeAudio(uri, FileSystem.uploadAsync, FileSystem.FileSystemUploadType);
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
      } catch (e) {
        setStatus(`无法启动录音：${e.message}`);
      }
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <View style={styles.topRow}>
        <TouchableOpacity onPress={toggleTts} style={styles.topBtn}>
          <Text style={[styles.topBtnText, { color: theme.textSecondary }]}>{ttsOn ? '🔊' : '🔇'}</Text>
        </TouchableOpacity>
        <Text style={[styles.topTitle, { color: theme.text }]} numberOfLines={1}>{bookTitle}</Text>
        <TouchableOpacity onPress={onClose} style={styles.topBtn}>
          <Text style={[styles.topBtnText, { color: theme.textSecondary }]}>⌄ 收起</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.styleToggleRow}>
        <TouchableOpacity
          style={[
            styles.styleToggleBtn,
            { borderRadius: theme.radius, borderColor: theme.cardBorder, backgroundColor: theme.cardBg },
            style === 'simple' && { backgroundColor: theme.accent, borderColor: theme.accent },
          ]}
          onPress={() => setStyle('simple')}
        >
          <Text style={[styles.styleToggleText, { color: style === 'simple' ? theme.textOnAccent : theme.textSecondary }]}>讲解</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.styleToggleBtn,
            { borderRadius: theme.radius, borderColor: theme.cardBorder, backgroundColor: theme.cardBg },
            style === 'socratic' && { backgroundColor: theme.accent, borderColor: theme.accent },
          ]}
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
          <Text style={[styles.styleToggleText, { color: style === 'socratic' ? theme.textOnAccent : theme.textSecondary }]}>苏格拉底</Text>
        </TouchableOpacity>
      </View>

      {!!selection && (
        <View style={[styles.selectionBar, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}>
          <Text style={[styles.selectionText, { color: theme.textSecondary }]} numberOfLines={2}>“{selection}”</Text>
          {!!cfiRange && (
            <TouchableOpacity
              style={[
                styles.saveHighlightBtn,
                { borderRadius: theme.radius, backgroundColor: highlightSaved ? theme.accentSoft : theme.tagSoft },
              ]}
              onPress={handleSaveHighlight}
              disabled={highlightSaved || savingHighlight}
            >
              <Text style={[styles.saveHighlightText, { color: highlightSaved ? theme.accent : theme.tag }]}>
                {highlightSaved ? '✓ 已划线' : '📌 存为划线'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <BottomSheetScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.msgContent}
      >
        {messages.length === 0 && (
          <Text style={[styles.emptyHint, { color: theme.textMuted }]}>
            {selection ? '针对这段文字提问，或者随便聊聊' : '用语音或文字提问'}
          </Text>
        )}
        {messages.map(m => <Bubble key={m.id} role={m.role} text={m.text} theme={theme} />)}
        {isThinking && streamingId === null && <TypingBubble theme={theme} />}
      </BottomSheetScrollView>

      {!!status && <Text style={[styles.status, { color: theme.textMuted }]} numberOfLines={2}>{status}</Text>}

      {(isThinking || isSpeaking) && (
        <TouchableOpacity
          style={[styles.interruptBar, { borderRadius: theme.radius, backgroundColor: theme.dangerSoft, borderColor: theme.danger }]}
          onPress={handleInterrupt}
        >
          <Text style={[styles.interruptBarText, { color: theme.danger }]}>
            ⏹ {isThinking ? '打断生成' : '打断播放'}，说点别的
          </Text>
        </TouchableOpacity>
      )}

      <View style={[styles.inputRow, { backgroundColor: theme.cardBg, borderTopColor: theme.cardBorder }]}>
        <TouchableOpacity
          style={[styles.voiceBtn, { backgroundColor: isRecording ? theme.danger : theme.accent }]}
          onPress={toggleRecording}
          disabled={isThinking}
        >
          <Text style={styles.voiceIcon}>{isRecording ? '⏹' : '🎤'}</Text>
        </TouchableOpacity>

        <TextInput
          style={[styles.textInput, { borderRadius: theme.radius, backgroundColor: theme.bg, borderColor: theme.cardBorder, color: theme.text }]}
          value={input}
          onChangeText={setInput}
          placeholder="输入问题…"
          placeholderTextColor={theme.textMuted}
          returnKeyType="send"
          onSubmitEditing={() => handleSend(input)}
          editable={!isThinking}
        />

        <TouchableOpacity
          style={[
            styles.sendBtn,
            { borderRadius: theme.radius, backgroundColor: theme.accent },
            (!input.trim() || isThinking) && styles.sendBtnOff,
          ]}
          onPress={() => handleSend(input)}
          disabled={!input.trim() || isThinking}
        >
          <Text style={[styles.sendText, { color: theme.textOnAccent }]}>发送</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  topRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 6,
  },
  topBtn: { padding: 6, minWidth: 44 },
  topBtnText: { fontSize: 14, fontWeight: '600' },
  topTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '700' },

  styleToggleRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  styleToggleBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1,
  },
  styleToggleText: { fontSize: 13, fontWeight: '600' },

  selectionBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 16, marginBottom: 8, padding: 10,
    borderWidth: 0.5, borderRadius: 8,
  },
  selectionText: { flex: 1, fontSize: 13, fontStyle: 'italic' },
  saveHighlightBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  saveHighlightText: { fontSize: 12, fontWeight: '600' },

  messages:   { flex: 1 },
  msgContent: { paddingHorizontal: 16, paddingBottom: 8 },
  emptyHint: {
    textAlign: 'center', fontSize: 13,
    marginTop: 24, lineHeight: 24,
  },

  bubble: { maxWidth: '85%', padding: 10, marginBottom: 8 },
  bubbleUser: { alignSelf: 'flex-end' },
  bubbleAI:   { alignSelf: 'flex-start' },
  bubbleText: { fontSize: 14, lineHeight: 22 },
  typingText: { letterSpacing: 6 },

  status: {
    textAlign: 'center', fontSize: 12,
    paddingHorizontal: 16, paddingVertical: 5,
  },

  interruptBar: {
    marginHorizontal: 16, marginBottom: 8, paddingVertical: 10,
    borderWidth: 1, alignItems: 'center',
  },
  interruptBarText: { fontSize: 13, fontWeight: '600' },

  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: 24, // 面板底部留白，避免贴着手机底部安全区/home indicator
  },
  voiceBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  voiceIcon: { fontSize: 18 },

  textInput: {
    flex: 1, height: 44, paddingHorizontal: 12,
    fontSize: 14, borderWidth: 1.5,
  },
  sendBtn: {
    height: 44, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnOff: { opacity: 0.45 },
  sendText:   { fontSize: 14, fontWeight: '600' },
});
