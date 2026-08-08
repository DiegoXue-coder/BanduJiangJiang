// 阶段十七：听书核心体验v1（按钮打断版）——独立于ReaderScreen里"问AI"的
// 聊天面板，这里是"持续朗读书本正文，随时能打断问问题，问完接着往下听"
// 这条单独的交互线。跟BookChatScreen的TTS播放队列（预取下一句、拼短句）
// 不是同一套代码——那套是给"AI流式吐字、边生成边念"设计的，这里书本内容
// 是提前一次性知道的（不是流式生成的），用不着那套预取重叠优化，改成
// 简单的"一段一段顺序加载播放"，代码简单很多，也不会带上那套至今还没
// 排查清楚的乱序/丢句问题（阶段十七开工前置条件那次真机没能复现，日志
// 还留着，详见04-开发进度记录.md）。
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, ScrollView, Platform, KeyboardAvoidingView, Switch,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { IconPlayerStop, IconSettings, IconMicrophone } from '@tabler/icons-react-native';
import {
  getBookContext, getChapterText, getTtsPlayUrl, transcribeAudio,
  streamAsk, saveHighlight, saveQaHistory,
} from '../lib/api';
import { useTheme } from '../theme';

// 决策层这轮派发的任务之一：语速/声音可调。不做完整的14个声音选择器，
// 参照用户真机反馈（中庸默认语速"灾难级别"、想要更沉稳的男声）给一组
// 精选预设——语速3档、声音4档（默认女声+3个候选男声，云健最接近用户
// 描述的"智者感"），够用且不用维护一个复杂的选择UI。
const RATE_OPTIONS = [
  { label: '慢', value: '-30%' },
  { label: '正常', value: '+0%' },
  { label: '快', value: '+20%' },
];
const VOICE_OPTIONS = [
  { label: '晓晓（默认女声）', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '云健（沉稳男声）', value: 'zh-CN-YunjianNeural' },
  { label: '云希（男声）', value: 'zh-CN-YunxiNeural' },
  { label: '晓伊（女声）', value: 'zh-CN-XiaoyiNeural' },
];
const MAX_RECORDING_MS = 55000; // 跟BookChatScreen同一个上限，腾讯云ASR单次连接60秒硬顶

// 章节标题精确匹配"目录"就跳过不朗读——已有真实案例证明目录会被当成
// 普通章节混进朗读队列（IMG_1564排版反馈截图），不追求覆盖所有变体，
// 简单规则，识别不到的边界情况留给以后真出现真实案例再处理。
function isTocChapter(title) {
  return (title || '').trim() === '目录';
}

// 真机反馈：有些书的<p>标签切得很碎，逐段单独发一次TTS请求，段与段之间
// 的网络往返间隔听起来就是"总之。当时的资本主义。和科学。"这种一顿一顿
// 的蠢断句——不是卡顿，是请求次数太多。参照BookChatScreen"攒够字数再发"
// 那套已经验证过的思路（同一个项目的既有模式，不是新发明），把连续的
// 短段落合并到一定长度再当一整段发去TTS，减少请求次数、拉长每段播放
// 时长，让停顿没那么频繁。
//
// 2026-08-08真机反馈坐实过一版纯按长度切的bug：原书文字提取本身有时会
// 把一个词从中间切断（比如"古典"被切成两个相邻段落"...成了古"+"典派
// 的遗韵..."），第一版合并逻辑只看攒够长度就切，切的时候不看切在哪个
// 字上，刚好切在段落边界=刚好切在这个词中间，把词audibly拆成了两次
// 独立的TTS请求，中间隔了十几秒——比不合并时更违和，因为其他正常断句
// 的地方没有这个问题，唯独这种"词跨段落边界"的地方会撞上。改成跟
// BookChatScreen的flushSentences完全一样的算法：先把整章所有段落拼成
// 一整块文本（拼接时不加任何分隔符，让原本被错误切断的词重新连续），
// 再按句末标点(。！？；换行)找真正的句子边界切，只在标点处切、攒够
// 长度才切——绝不会再切在句子中间，天然连"古典"这种词跨段落的情况都能
// 正确愈合，不用额外判断。
const NARRATION_SENTENCE_END = /([。！？；\n])/;
const NARRATION_MIN_CHUNK_LEN = 60;

function mergeParagraphsForNarration(paragraphs) {
  let buffer = paragraphs.join('');
  const merged = [];
  let pending = '';
  for (;;) {
    const idx = buffer.search(NARRATION_SENTENCE_END);
    if (idx === -1) break;
    pending += buffer.slice(0, idx + 1);
    buffer = buffer.slice(idx + 1);
    if (pending.length >= NARRATION_MIN_CHUNK_LEN) {
      merged.push(pending);
      pending = '';
    }
  }
  pending += buffer; // 结尾不满一句/不够长度的尾巴，直接并进最后一段，不丢内容
  if (pending) merged.push(pending);
  return merged;
}

export default function ListenScreen({ route, navigation }) {
  const { bookId, bookTitle, author, initialChapterTitle } = route.params;
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // phase: loading-book(打开界面首次拉章节列表) / loading-chapter(章节文字
  // 还没拉到) / playing / paused(打断后，等用户提问) / thinking(等AI回答)
  // / answering(播AI回答语音) / post-answer(回答完，可以追问/继续听书/结束)
  // / done(全书听完) / error
  const [phase, setPhase] = useState('loading-book');
  const [errorMsg, setErrorMsg] = useState('');
  const [chapterTitle, setChapterTitle] = useState('');
  const [progressLabel, setProgressLabel] = useState('');
  const [capturedText, setCapturedText] = useState('');
  const [question, setQuestion] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [rate, setRate] = useState('+0%');
  const [voice, setVoice] = useState('zh-CN-XiaoxiaoNeural');
  // 决策层这轮派发：划线自动保存改成默认不存，用户自己勾选才存——之前
  // 每次打断提问都无条件写highlights，用户验收时明确提出想要选择权。
  const [saveAsHighlight, setSaveAsHighlight] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('');

  // playOneParagraph在playFrom的异步循环里调用，如果直接读voice/rate这两个
  // state会有闭包过期的问题（循环开始时闭包捕获的是当时的值，用户中途在
  // 设置面板改了声音，正在进行的循环感知不到）——用ref同步更新，效果是
  // "下一句开始播放就用新设置"，不用整个重启听书。
  const rateRef = useRef(rate);
  const voiceRef = useRef(voice);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);

  const chaptersRef = useRef([]); // 已经过滤掉"目录"章节的列表
  const paragraphCacheRef = useRef({}); // chapterId -> string[]
  const epochRef = useRef(0); // 每次打断/停止自增，让还没awaitresolve的加载能认出自己过期
  const soundRef = useRef(null);
  const posRef = useRef({ chapterIdx: 0, paragraphIdx: 0 }); // 当前/暂停时的位置
  const abortAskRef = useRef(null);
  // 决策层这轮派发：打断提问支持连续追问。这一轮打断期间的问答历史存这里
  // （不是整本书的历史，每次打断/继续听书都会清空），追问时当成history喂
  // 给streamAsk，让AI知道"追问"跟前一个问题是同一轮对话，不是从零开始。
  const conversationRef = useRef([]);
  const recordingRef = useRef(null);
  const startingRecordingRef = useRef(false);
  const maxDurationTimerRef = useRef(null);

  async function stopSound() {
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => {});
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
  }

  async function playOneParagraph(text, epoch, onAudioStart) {
    const { sound } = await Audio.Sound.createAsync(
      { uri: getTtsPlayUrl(text, voiceRef.current, rateRef.current) },
      { shouldPlay: false },
    );
    if (epoch !== epochRef.current) {
      sound.unloadAsync().catch(() => {});
      return;
    }
    soundRef.current = sound;
    onAudioStart?.(); // 真正要出声了才回调——见调用处注释，打断截取的位置要跟这个对齐
    await new Promise((resolve) => {
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.didJustFinish) resolve();
      });
      sound.playAsync().catch(() => resolve()); // 播放本身失败也别卡住整个循环，跳过这段
    });
  }

  // 从指定位置开始顺序朗读，直到打断（epoch变化）或全书听完。
  // 打断的粒度是"段落"——不做音频内细粒度进度记录，暂停即重播该段
  // （不是从头也不是丢段，是这次没有更细粒度可用时最合理的中间选择）。
  const playFrom = useCallback(async (startChapterIdx, startParagraphIdx, epoch) => {
    const chapters = chaptersRef.current;
    let ci = startChapterIdx;
    let pi = startParagraphIdx;
    while (ci < chapters.length) {
      if (epoch !== epochRef.current) return;
      const chapter = chapters[ci];
      let paragraphs = paragraphCacheRef.current[chapter.id];
      if (!paragraphs) {
        setPhase('loading-chapter');
        setChapterTitle(chapter.title);
        try {
          const data = await getChapterText(bookId, chapter.id);
          paragraphs = mergeParagraphsForNarration(data.paragraphs || []);
          // 临时诊断：真机反馈"只听到'前言'两个字，后面都没有了"，加日志
          // 确认到底是"这一章后端就只返回了一段"，还是"返回了多段但播放
          // 循环提前退出"，不能靠猜。排查完就删。
          console.log(`[听书诊断] 章节"${chapter.title}"(id=${chapter.id})合并后${paragraphs.length}段：`, paragraphs.map((p) => p.slice(0, 10)));
        } catch (e) {
          console.log(`[听书诊断] 章节"${chapter.title}"加载失败：${e.message}`);
          if (epoch !== epochRef.current) return;
          setErrorMsg(e.message || '章节加载失败');
          setPhase('error');
          return;
        }
        if (epoch !== epochRef.current) return;
        paragraphCacheRef.current[chapter.id] = paragraphs;
      }
      while (pi < paragraphs.length) {
        if (epoch !== epochRef.current) {
          console.log(`[听书诊断] epoch过期(${epoch}→${epochRef.current})，播放循环退出，位置=${ci}/${pi}`);
          return;
        }
        setChapterTitle(chapter.title);
        setProgressLabel(`第${pi + 1}/${paragraphs.length}段（加载中…）`);
        setPhase('playing');
        console.log(`[听书诊断] 开始加载 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段`);
        try {
          await playOneParagraph(paragraphs[pi], epoch, () => {
            // 真机反馈过"打断时截取的是刚讲到那段的后面一段，不是刚讲到
            // 的那段"——根因是原来在"这段还没开始出声、还在等TTS合成"
            // 这个加载阶段，就把posRef改成了这一段，用户如果在这段真正
            // 出声之前打断（比如以为卡住了、在10秒静默间隔里点了打断），
            // 截取到的就是用户实际上根本没听到的下一段。改成真正开始
            // 出声这一刻才更新posRef，跟用户耳朵听到的内容对齐。
            posRef.current = { chapterIdx: ci, paragraphIdx: pi };
            setProgressLabel(`第${pi + 1}/${paragraphs.length}段`);
            console.log(`[听书诊断] 开始出声 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段`);
          });
          console.log(`[听书诊断] 播放完成 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段`);
        } catch (e) {
          console.log(`[听书诊断] 播放出错，跳过这段：${e.message}`);
        }
        if (soundRef.current) {
          soundRef.current.unloadAsync().catch(() => {});
          soundRef.current = null;
        }
        if (epoch !== epochRef.current) {
          console.log(`[听书诊断] 播完这段后epoch已过期，循环退出`);
          return;
        }
        pi += 1;
      }
      console.log(`[听书诊断] 章节"${chapter.title}"全部段落播完，切下一章`);
      ci += 1;
      pi = 0;
    }
    console.log('[听书诊断] 全书播放完毕');
    if (epoch === epochRef.current) setPhase('done');
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true }).catch(() => {});
    getBookContext(bookId).then((ctx) => {
      if (cancelled) return;
      const filtered = (ctx.chapters || []).filter((c) => !isTocChapter(c.title));
      chaptersRef.current = filtered;
      if (filtered.length === 0) {
        setErrorMsg('这本书没有可朗读的章节');
        setPhase('error');
        return;
      }
      // 用户反馈"一点听书就只能从前言开始，不会从当前页开始"——从阅读器
      // 传来的initialChapterTitle（epub.js当前location的章节标题）按标题
      // 文本匹配定位起始章节，找不到（标题不完全一致、或没传）就退回从头。
      // 只能定位到"章"这个粒度，不是段落精确位置——章节内epub.js的CFI跟
      // 这边独立拉取的段落数组之间没有直接映射关系，做不到更精确的定位。
      const wanted = (initialChapterTitle || '').trim();
      const startIdx = wanted ? filtered.findIndex((c) => c.title.trim() === wanted) : -1;
      playFrom(startIdx >= 0 ? startIdx : 0, 0, epochRef.current);
    }).catch((e) => {
      if (cancelled) return;
      setErrorMsg(e.message || '书本信息加载失败');
      setPhase('error');
    });
    return () => {
      cancelled = true;
      epochRef.current += 1;
      stopSound();
      abortAskRef.current?.();
      if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  function handleInterrupt() {
    if (phase !== 'playing' && phase !== 'loading-chapter') return;
    epochRef.current += 1;
    stopSound();
    const { chapterIdx, paragraphIdx } = posRef.current;
    const chapter = chaptersRef.current[chapterIdx];
    const paragraphs = paragraphCacheRef.current[chapter?.id] || [];
    setCapturedText(paragraphs[paragraphIdx] || '');
    setQuestion('');
    setAnswerText('');
    conversationRef.current = []; // 新一次打断，追问历史清空重新开始
    setPhase('paused');
  }

  // 回答完之后想继续追问——回到提问界面，但保留capturedText（还是同一段
  // 上下文）和conversationRef（这一轮已经问过的内容，喂给下一次streamAsk
  // 当history，让AI知道这是连续对话，不是全新的孤立提问）。
  function handleAskAgain() {
    setQuestion('');
    setAnswerText('');
    setPhase('paused');
  }

  function handleAsk() {
    const q = question.trim();
    if (!q) return;
    setPhase('thinking');
    const chapter = chaptersRef.current[posRef.current.chapterIdx];
    let fullAnswer = '';
    abortAskRef.current = streamAsk(
      {
        context: {
          bookTitle, author, chapterTitle: chapter?.title || '',
          selection: capturedText, pageText: '',
          userHighlights: [], popularHighlights: [],
        },
        question: q,
        style: 'simple',
        history: conversationRef.current,
      },
      {
        onDelta: (delta) => { fullAnswer += delta; },
        onDone: async (answer) => {
          abortAskRef.current = null;
          setAnswerText(answer);
          conversationRef.current = [
            ...conversationRef.current,
            { role: 'user', content: q },
            { role: 'assistant', content: answer },
          ];
          // 打断瞬间截取的段落，本来无条件当成一次"自动划线"存下来——
          // 用户验收时明确提出想自己决定要不要存，改成只有勾选了"保存为
          // 划线"才写。cfi_location用不了真实CFI（这里没有驱动epub.js，
          // 只是纯数据段落），用"listen:章节id:段落序号"这种可辨识的
          // 假位置代替，如实说明：从复盘页点这条划线跳回书里定位不了，
          // 是已知限制，不是bug。问答记录（qa_history）不受这个开关影响，
          // 始终保存——用户要自己选的是"划线"，不是"这次问答有没有记录"。
          const fakeCfi = `listen:${chapter?.id}:${posRef.current.paragraphIdx}`;
          if (saveAsHighlight) {
            saveHighlight(bookId, { cfiLocation: fakeCfi, highlightedText: capturedText }).catch(() => {});
          }
          saveQaHistory({
            bookId, bookTitle, chapterTitle: chapter?.title || '',
            question: q, answer, selection: capturedText, cfiRange: fakeCfi,
          }).catch(() => {});
          setPhase('answering');
          const epoch = epochRef.current;
          try {
            await playOneParagraph(answer, epoch);
          } catch (e) {
            // 回答播放失败不影响后续流程
          }
          if (soundRef.current) {
            soundRef.current.unloadAsync().catch(() => {});
            soundRef.current = null;
          }
          if (epoch === epochRef.current) setPhase('post-answer');
        },
        onError: (e) => {
          abortAskRef.current = null;
          setErrorMsg(e.message || '提问失败');
          setPhase('error');
        },
      },
    );
  }

  function handleContinue() {
    conversationRef.current = []; // 回到听书主线，这一轮打断的追问历史结束
    const { chapterIdx, paragraphIdx } = posRef.current;
    playFrom(chapterIdx, paragraphIdx, epochRef.current);
  }

  function handleStopListening() {
    epochRef.current += 1;
    stopSound();
    navigation.goBack();
  }

  // 决策层这轮派发：打断提问改成语音输入。逻辑照抄BookChatScreen已经在
  // 真机上验证过的录音实现（prepareToRecordAsync+startAsync两步走绕开
  // iOS麦克风预热延迟、55秒自动停止避免撞腾讯云ASR60秒硬顶）——同一套
  // 麦克风坑没必要重新踩一遍。区别只是识别完文字填进question而不是input。
  async function finishRecording() {
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
    setIsRecording(false);
    setRecordingStatus('识别中…');
    try {
      const rec = recordingRef.current;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      recordingRef.current = null;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const text = await transcribeAudio(uri, FileSystem.uploadAsync, FileSystem.FileSystemUploadType);
      if (text?.trim()) {
        setQuestion(text.trim());
        setRecordingStatus('识别完成 — 确认后点提问');
      } else {
        setRecordingStatus('未识别到内容，请重试');
      }
    } catch (e) {
      setRecordingStatus(`识别失败：${e.message}`);
    }
  }

  async function toggleRecording() {
    if (isRecording) {
      await finishRecording();
      return;
    }
    if (startingRecordingRef.current) return;
    startingRecordingRef.current = true;
    try {
      const { status: perm } = await Audio.requestPermissionsAsync();
      if (perm !== 'granted') {
        setRecordingStatus('需要麦克风权限，请到系统设置里开启');
        return;
      }
      setRecordingStatus('准备麦克风…');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      await new Promise((resolve) => setTimeout(resolve, 300));
      setIsRecording(true);
      setRecordingStatus('录音中 — 再次点击停止');
      maxDurationTimerRef.current = setTimeout(() => { finishRecording(); }, MAX_RECORDING_MS);
    } catch (e) {
      setRecordingStatus(`无法启动录音：${e.message}`);
    } finally {
      startingRecordingRef.current = false;
    }
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.accent, paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={handleStopListening} style={styles.headerBtn}>
          <Text style={[styles.headerBtnText, { color: theme.textOnAccent }]}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.textOnAccent }]} numberOfLines={1}>{bookTitle}</Text>
        <TouchableOpacity onPress={() => setShowSettings((v) => !v)} style={styles.headerBtn}>
          <IconSettings color={theme.textOnAccent} size={20} strokeWidth={1.75} />
        </TouchableOpacity>
      </View>

      {showSettings && (
        <View style={[styles.settingsPanel, { backgroundColor: theme.cardBg, borderBottomColor: theme.cardBorder }]}>
          <Text style={[styles.settingsLabel, { color: theme.textSecondary }]}>语速</Text>
          <View style={styles.chipRow}>
            {RATE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.chip,
                  { borderColor: theme.cardBorder, borderRadius: theme.radius },
                  rate === opt.value && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
                onPress={() => setRate(opt.value)}
              >
                <Text style={[styles.chipText, { color: rate === opt.value ? theme.textOnAccent : theme.text }]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={[styles.settingsLabel, { color: theme.textSecondary, marginTop: 10 }]}>声音</Text>
          <View style={styles.chipRow}>
            {VOICE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.chip,
                  { borderColor: theme.cardBorder, borderRadius: theme.radius },
                  voice === opt.value && { backgroundColor: theme.accent, borderColor: theme.accent },
                ]}
                onPress={() => setVoice(opt.value)}
              >
                <Text style={[styles.chipText, { color: voice === opt.value ? theme.textOnAccent : theme.text }]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.body}>
          {(phase === 'loading-book') && (
            <View style={styles.centerBox}><ActivityIndicator color={theme.accent} /></View>
          )}

          {phase === 'error' && (
            <View style={styles.centerBox}>
              <Text style={[styles.errorText, { color: theme.danger }]}>{errorMsg}</Text>
            </View>
          )}

          {(phase === 'playing' || phase === 'loading-chapter') && (
            <View style={styles.centerBox}>
              <Text style={[styles.chapterLabel, { color: theme.textSecondary }]}>{chapterTitle}</Text>
              {phase === 'loading-chapter' ? (
                <ActivityIndicator color={theme.accent} style={{ marginTop: 12 }} />
              ) : (
                <>
                  <Text style={[styles.playingHint, { color: theme.text }]}>正在朗读…</Text>
                  <Text style={[styles.progressLabel, { color: theme.textMuted }]}>{progressLabel}</Text>
                </>
              )}
              <TouchableOpacity
                style={[styles.interruptBtn, { backgroundColor: theme.danger, borderRadius: theme.radius }]}
                onPress={handleInterrupt}
              >
                <IconPlayerStop color="#fff" size={20} strokeWidth={2} />
                <Text style={styles.interruptBtnText}>打断</Text>
              </TouchableOpacity>
            </View>
          )}

          {phase === 'paused' && (
            <ScrollView contentContainerStyle={styles.pausedContent}>
              <Text style={[styles.capturedLabel, { color: theme.textSecondary }]}>刚才讲到——</Text>
              <View style={[styles.capturedBox, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
                <Text style={[styles.capturedText, { color: theme.text }]}>{capturedText}</Text>
              </View>
              <View style={styles.questionRow}>
                <TextInput
                  style={[styles.questionInput, styles.questionInputFlex, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, color: theme.text, borderRadius: theme.radius }]}
                  placeholder={'想问点什么？（比如"你刚才说的这个是什么意思"）'}
                  placeholderTextColor={theme.textMuted}
                  value={question}
                  onChangeText={setQuestion}
                  multiline
                />
                <TouchableOpacity
                  style={[
                    styles.micBtn,
                    { borderColor: theme.cardBorder, borderRadius: theme.radius },
                    isRecording && { backgroundColor: theme.danger, borderColor: theme.danger },
                  ]}
                  onPress={toggleRecording}
                >
                  <IconMicrophone color={isRecording ? '#fff' : theme.text} size={20} strokeWidth={1.75} />
                </TouchableOpacity>
              </View>
              {!!recordingStatus && (
                <Text style={[styles.recordingStatus, { color: theme.textMuted }]}>{recordingStatus}</Text>
              )}
              <View style={styles.saveHighlightRow}>
                <Switch value={saveAsHighlight} onValueChange={setSaveAsHighlight} />
                <Text style={[styles.saveHighlightText, { color: theme.textSecondary }]}>把刚才这段保存为划线</Text>
              </View>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]}
                onPress={handleAsk}
                disabled={!question.trim()}
              >
                <Text style={[styles.primaryBtnText, { color: theme.textOnAccent }]}>提问</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkBtn} onPress={handleContinue}>
                <Text style={[styles.linkBtnText, { color: theme.textSecondary }]}>不问了，接着听</Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          {phase === 'thinking' && (
            <View style={styles.centerBox}>
              <ActivityIndicator color={theme.accent} />
              <Text style={[styles.playingHint, { color: theme.textSecondary, marginTop: 10 }]}>AI正在思考…</Text>
            </View>
          )}

          {phase === 'answering' && (
            <ScrollView contentContainerStyle={styles.pausedContent}>
              <Text style={[styles.capturedLabel, { color: theme.textSecondary }]}>回答：</Text>
              <Text style={[styles.capturedText, { color: theme.text }]}>{answerText}</Text>
            </ScrollView>
          )}

          {phase === 'post-answer' && (
            <View style={styles.centerBox}>
              <Text style={[styles.playingHint, { color: theme.text }]}>还要继续问，还是接着听？</Text>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]}
                onPress={handleAskAgain}
              >
                <Text style={[styles.primaryBtnText, { color: theme.textOnAccent }]}>继续追问</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: theme.accentSoft, borderRadius: theme.radius }]}
                onPress={handleContinue}
              >
                <Text style={[styles.primaryBtnText, { color: theme.text }]}>继续听书</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkBtn} onPress={handleStopListening}>
                <Text style={[styles.linkBtnText, { color: theme.textSecondary }]}>先到这里</Text>
              </TouchableOpacity>
            </View>
          )}

          {phase === 'done' && (
            <View style={styles.centerBox}>
              <Text style={[styles.playingHint, { color: theme.text }]}>这本书听完了</Text>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: theme.accent, borderRadius: theme.radius }]}
                onPress={handleStopListening}
              >
                <Text style={[styles.primaryBtnText, { color: theme.textOnAccent }]}>返回</Text>
              </TouchableOpacity>
            </View>
          )}
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
  headerTitle: { fontSize: 17, fontWeight: '700', flex: 1, textAlign: 'center' },
  body: { flex: 1, padding: 20 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  errorText: { fontSize: 14, textAlign: 'center' },
  chapterLabel: { fontSize: 14, marginBottom: 16 },
  playingHint: { fontSize: 18, fontWeight: '600' },
  progressLabel: { fontSize: 13, marginTop: 6 },
  interruptBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 28, paddingVertical: 14, marginTop: 32,
  },
  interruptBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  pausedContent: { padding: 4, gap: 12 },
  capturedLabel: { fontSize: 13 },
  capturedBox: { borderWidth: 1, padding: 12 },
  capturedText: { fontSize: 15, lineHeight: 22 },
  questionInput: { borderWidth: 1, padding: 12, fontSize: 14, minHeight: 80, textAlignVertical: 'top' },
  primaryBtn: { paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryBtnText: { fontSize: 15, fontWeight: '700' },
  linkBtn: { alignItems: 'center', paddingVertical: 10 },
  linkBtnText: { fontSize: 14 },
  settingsPanel: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  settingsLabel: { fontSize: 12, marginBottom: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13 },
  questionRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  questionInputFlex: { flex: 1 },
  micBtn: { borderWidth: 1, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  recordingStatus: { fontSize: 12 },
  saveHighlightRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  saveHighlightText: { fontSize: 13 },
});
