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
  PermissionsAndroid, Animated, Easing, Modal, FlatList,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import Slider from '@react-native-community/slider';
import {
  IconMicrophone, IconChevronLeft, IconList, IconVolume, IconBolt,
  IconPlayerPlay, IconPlayerPause, IconPlayerTrackPrev, IconPlayerTrackNext,
  IconMicrophoneOff, IconVolumeOff, IconSend2,
} from '@tabler/icons-react-native';
import {
  getBookContext, getChapterText, getTtsPlayUrl, transcribeAudio,
  streamAsk, saveHighlight, saveQaHistory,
} from '../lib/api';

// 决策层这轮派发：听书界面套用定稿设计稿的视觉语言（docs/设计稿/听书界面-
// 设计稿.html，2026-08-10定稿）。这套"沉光"配色是这个页面专属的暗色调
// （灯芯/余烬/纸色），故意不用theme.js里全App统一的"暖纸古风"亮色系——
// 设计稿本身就是新起一套独立视觉身份，不是复用App其它页面的配色。数值
// 直接抄设计稿CSS里的--ink/--ember这些变量，没有另外发挥。
const LISTEN_THEME = {
  ink: '#241a12',
  dusk: '#33241a',
  dusk2: '#443021',
  paper: '#f2e6d2',
  paperDim: '#cbb896',
  inkSoft: '#b8a488',
  ember: '#e2963a',
  emberBright: '#f3b563',
  emberDim: '#8c5a22',
  jade: '#6fa088',
  jadeDim: '#3d5b4c',
};

// 决策层这轮派发的任务之一：语速/声音可调。不做完整的14个声音选择器，
// 参照用户真机反馈（中庸默认语速"灾难级别"、想要更沉稳的男声）给一组
// 精选预设——语速3档、声音4档（默认女声+3个候选男声，云健最接近用户
// 描述的"智者感"），够用且不用维护一个复杂的选择UI。
// 真机反馈过两轮：先是3档（慢/正常/快）不够用，改成6档倍速；这次真机
// 反馈6档也不够细，要求能像滑动条一样自由微调到0.8x/0.7x这种任意值，
// 范围定成0.75x~2x（比上一版的0.75x~3x收窄，3倍速这类极端值用户反馈
// 用不上）。edge_tts的rate参数是"比该声音的基准语速快/慢百分之多少"，
// 近似等于播放倍速的百分比换算（1.5倍速≈"+50%"，0.75倍速≈"-25%"）——
// 不是像视频播放器那样对已有音频做变速处理，是让TTS合成时就用这个速率
// 说话，效果类似但原理不同，如实说明这是近似值不是精确的秒数换算。
const RATE_MIN = 0.75;
const RATE_MAX = 2;
const RATE_STEP = 0.05;

function rateMultiplierToStr(m) {
  const pct = Math.round((m - 1) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}
function rateStrToMultiplier(str) {
  const pct = parseInt(str, 10);
  return Number.isFinite(pct) ? 1 + pct / 100 : 1;
}
const VOICE_OPTIONS = [
  { label: '晓晓（默认女声）', value: 'zh-CN-XiaoxiaoNeural' },
  { label: '云健（沉稳男声）', value: 'zh-CN-YunjianNeural' },
  { label: '云希（男声）', value: 'zh-CN-YunxiNeural' },
  { label: '晓伊（女声）', value: 'zh-CN-XiaoyiNeural' },
];
const MAX_RECORDING_MS = 55000; // 跟BookChatScreen同一个上限，腾讯云ASR单次连接60秒硬顶

// 2026-08-09决策层派发"方案A"：AI回答完之后的等待期，除了手动点"继续
// 听书"按钮，同时临时开一次麦克风监听——说"继续"这类词就自动接回朗读，
// 不用点按钮。这个跟免提打断（方案B，持续收音+VAD）完全不同：这里只在
// 明确的等待窗口临时录一小段（复用下面已有的一次性录音+云端识别逻辑，
// 不需要持续收音、也不需要VAD做本地语音检测），窗口结束就自动停止，
// 不是全程开麦。
const AUTO_LISTEN_WINDOW_MS = 4000;
// 宽松包含匹配，不要求精确匹配整句——真实语音识别经常带标点/语气词
// （比如"继续吧。"、"没事了"）。限制文字长度是为了避免长问题里偶然
// 包含"算了"这类词被误判成"继续"指令（比如"算了这段的账目是什么意思"
// 这种问题不应该被拦截）。
const CONTINUE_VOICE_PATTERNS = ['继续', '没事', '不问了', '算了', '好了', '行了', '够了', '不用了'];
function isContinueVoiceCommand(text) {
  const t = (text || '').trim();
  if (!t || t.length > 8) return false;
  return CONTINUE_VOICE_PATTERNS.some((p) => t.includes(p));
}

// 方案B：免提打断——朗读时持续开麦监听音量（复用AEC技术验证spike里已经
// 真机验证过的react-native-webrtc+react-native-incall-manager这套组合），
// 检测到用户开始说话就自动触发跟手动按"打断"完全一样的流程，不需要碰
// 屏幕。阈值和轮询间隔直接沿用WebrtcAecTestScreen.js里用户真机实测校准
// 过的数值（安静~0.0003、说话3000~5000，量级差了一千万倍，不是W3C规范
// 说的0~1范围，这个库在安卓上就是这么实现的，但完全不影响用相对大小做
// 判断）——两处常量如果以后要调，记得两个文件一起改。
const VAD_POLL_INTERVAL_MS = 300;
const VAD_SPEECH_THRESHOLD = 1.0;
// 连续多少次轮询都超过阈值才算"真的开始说话"（而不是一声咳嗽/物体碰撞
// 这种瞬间噪音）——2次×300ms＝大约600ms持续声音才触发，真人开口说话
// 通常不会只响一瞬间就停，短促噪音大概率撑不到600ms。
const VAD_SUSTAIN_POLLS = 2;

// 章节标题精确匹配"目录"就跳过不朗读——已有真实案例证明目录会被当成
// 普通章节混进朗读队列（IMG_1564排版反馈截图），不追求覆盖所有变体，
// 简单规则，识别不到的边界情况留给以后真出现真实案例再处理。
function isTocChapter(title) {
  return (title || '').trim() === '目录';
}

const LIST_MARKER_PAUSE_MS = 350; // 念到编号开头的段落前，额外停顿这么久

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// 真机反馈：编号列表（"一、……二、……"这类）朗读起来听不出层次，跟前后
// 文字粘在一起。查证过技术方案：edge_tts从5.0起微软禁掉了自定义SSML，
// 没法让TTS引擎自己在指定文字位置插入静音，只能在应用层做——识别编号
// 标记在文本里的位置，强制在那里断成独立的一段（哪怕没攒够
// NARRATION_MIN_CHUNK_LEN也要断，这条边界不能被长度累积吞并），播放
// 循环里切到这种"以编号开头"的段落前，额外插入一小段静音停顿。只处理
// 中文数字/阿拉伯数字+顿号或括号这类明确、低误判风险的标记（比如"一、"
// "（1）"），不处理阿拉伯数字+逗号这种（"2，"太容易跟普通数字撞车，
// 比如"2019，"），是刻意收窄的范围，不追求覆盖所有列表写法。
const LIST_MARKER_RE = /^([一二三四五六七八九十百]{1,3}[、，]|[（(][一二三四五六七八九十0-9]{1,3}[）)]|[0-9]{1,3}、)/;

// 字幕分句：跟NARRATION_SENTENCE_END用同一套标点边界，只是这里不做"攒够
// 长度才切"那一层（字幕要的是"念到哪一句了"，不是"攒够多长发一次请求"），
// 单纯按标点切开，标点本身保留在句尾（比如"天命之谓性，"，不是"天命之谓性"）。
function splitIntoSentences(text) {
  const parts = (text || '').split(NARRATION_SENTENCE_END);
  const sentences = [];
  let buf = '';
  for (const part of parts) {
    buf += part;
    if (NARRATION_SENTENCE_END.test(part)) {
      sentences.push(buf);
      buf = '';
    }
  }
  if (buf) sentences.push(buf);
  return sentences.length ? sentences : [text || ''];
}

function mergeParagraphsForNarration(paragraphs) {
  let buffer = paragraphs.join('');
  const merged = [];
  let pending = '';
  for (;;) {
    if (pending && LIST_MARKER_RE.test(buffer)) {
      merged.push(pending);
      pending = '';
    }
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
  const { bookId, bookTitle, author, initialChapterTitle, startFraction } = route.params;
  const insets = useSafeAreaInsets();

  // phase: loading-book(打开界面首次拉章节列表) / loading-chapter(章节文字
  // 还没拉到) / playing / paused(打断后，对话线+输入框都在，等用户提问
  // 或点继续听书) / thinking(等AI回答) / answering(播AI回答语音，对话线
  // 上已经能看到文字答案) / done(全书听完) / error
  const [phase, setPhase] = useState('loading-book');
  const [errorMsg, setErrorMsg] = useState('');
  const [chapterTitle, setChapterTitle] = useState('');
  const [progressLabel, setProgressLabel] = useState('');
  const [capturedText, setCapturedText] = useState('');
  const [question, setQuestion] = useState('');
  // 决策层这轮派发：连续追问改成对话式UI——这一轮打断期间的问答历史，
  // 既用来渲染屏幕上的对话线，也直接当streamAsk的history参数（跟消息
  // 数组同一份数据，不用conversationRef另外再维护一份，见上面refs区
  // 的说明）。
  const [conversation, setConversation] = useState([]);
  const [rate, setRate] = useState('+0%');
  // 滑动条拖动过程中的实时显示值——跟rate分开，拖动时只更新这个数字标签
  // （流畅、不触发任何副作用），松手那一刻才调setRate真正提交（触发下面
  // 监听voice/rate变化、打断重播的effect）。如果拖动过程中就直接调
  // setRate，效果会是"每移动一点点就打断重播一次"，声音卡成一片。
  const [rateDisplay, setRateDisplay] = useState(1);
  const [voice, setVoice] = useState('zh-CN-XiaoxiaoNeural');
  // 决策层这轮派发：划线自动保存改成默认不存，用户自己勾选才存——之前
  // 每次打断提问都无条件写highlights，用户验收时明确提出想要选择权。
  const [saveAsHighlight, setSaveAsHighlight] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('');
  // 方案B：免提打断总开关（默认关闭，用户自己选择开启，不是默认行为）；
  // 静音只在免提开启时有意义，作用是"临时不响应自动打断"，不拆连接——
  // 连接本身开着，随时切回来不用重新连一次（重连有InCallManager+
  // getUserMedia这一整套流程，有肉眼可感的延迟）。
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(false);
  const [handsFreeMuted, setHandsFreeMuted] = useState(false);
  const [handsFreeStatus, setHandsFreeStatus] = useState('');

  // 任务1（听书界面视觉改造）新增的纯渲染层状态——不碰上面2号负责的phase/
  // 免提/录音状态定义，只是给新视觉多加了几个"要显示什么"的数据源。
  // 章节选择弹层（设计稿："点开是App已有的多层目录弹层，不用重新做一套"——
  // 但ListenScreen手上只有chaptersRef这份扁平章节列表，没有ReaderScreen
  // 那边epub.js渲染出来的嵌套toc数据，两边数据源不是一回事，做不到真的
  // 复用同一个组件实例。这里做了一个平级列表版本的选择弹层，视觉上贴这次
  // 的暗色设计语言，如实记这是跟设计稿字面要求的一个偏差，等反馈环节跟
  // 决策层说清楚，不是自己悄悄简化了不说。
  const [showChapterPicker, setShowChapterPicker] = useState(false);
  const [showRatePicker, setShowRatePicker] = useState(false);
  // 字幕：设计稿要求"一次只显示一句，随TTS播放进度自动滚动"。当前TTS是
  // 按合并后的整段（可能好几句）一次性合成，没有逐字/逐句的时间戳可用——
  // 用sound播放状态回调里真实的positionMillis/durationMillis比例，反推
  // 大概播到这一段里的第几句，是个近似值，不是精确对齐每个字，如实说明。
  const [captionSentences, setCaptionSentences] = useState([]);
  const [captionIdx, setCaptionIdx] = useState(0);
  // 进度条（任务2）：这套架构没有"整本书的总时长"概念——每段TTS都是现场
  // 按需合成的，没有预先量好全书时长，做不到设计稿demo那种mm:ss跨全书
  // 进度。退而求其次做"当前章节内，第几段/共几段"这个已有的颗粒度，拖动
  // 进度条＝跳到这一章的某个段落，不是跳到某个精确时间点——如实说明这是
  // 跟设计稿字面（06:12/-10:24这种时间格式）的一个偏差，反馈环节会说明。
  const [paragraphProgress, setParagraphProgress] = useState({ idx: 0, total: 0 });
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);

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
  // 真机反馈"段跟段之间停顿太长"——加预取：当前段刚开始出声，就在后台
  // 把下一段的TTS请求发出去，让加载时间跟当前段的播放时间重叠。跟
  // BookChatScreen"预取下一句"是同一个思路，但这边是ListenScreen自己的
  // 单线顺序循环（没有并发enqueue触发多次预取的场景），不会重演那边
  // 排查过的乱序/丢句那类问题——按位置(ci,pi)+voice+rate做匹配校验，
  // 位置或设置对不上就整个丢弃重新现场加载，不会把过期音频当成当前段播。
  const preparedRef = useRef(null); // { ci, pi, voice, rate, promise }
  const posRef = useRef({ chapterIdx: 0, paragraphIdx: 0 }); // 当前/暂停时的位置
  const abortAskRef = useRef(null);
  // 决策层这轮派发：连续追问的交互改成"对话式"，不是每次都跳回一个空白
  // 提问页——之前用ref存这一轮的问答历史只是为了喂给streamAsk当上下文，
  // 不会触发重新渲染，用户看不到。改成state，同时当"喂给AI的历史"和
  // "屏幕上要展示的对话线"两个用途，只维护一份数据，不重复。每次打断/
  // 继续听书清空，不是整本书的问答历史。
  const recordingRef = useRef(null);
  const startingRecordingRef = useRef(false);
  const maxDurationTimerRef = useRef(null);
  // true表示当前这段录音是"方案A"自动触发的监听窗口，不是用户手动点麦克风
  // 按钮开始的——finishRecording需要知道这个区别，来决定识别出的文字是
  // 填进输入框（手动场景）还是先检查是不是"继续"这类指令（自动场景）。
  const autoListenRef = useRef(false);
  const autoListenTimerRef = useRef(null);

  // 方案B免提打断用的WebRTC连接状态，命名前缀vad跟AEC测试页的命名保持
  // 一致，方便对照两处代码。
  const vadPc1Ref = useRef(null);
  const vadPc2Ref = useRef(null);
  const vadStreamRef = useRef(null);
  const vadInCallManagerRef = useRef(null);
  const vadPollTimerRef = useRef(null);
  const vadSustainCountRef = useRef(0); // 连续超过阈值的轮询次数
  const vadSpeakingRef = useRef(false); // 已经触发过一次打断、还没跌回安静，避免同一段话反复触发
  // 轮询定时器是startHandsFreeVad调用那一刻创建的，之后每次触发都要调用
  // "当前这次渲染"的handleAutoInterrupt（读到最新的phase/handsFreeMuted等
  // 状态）——跟方案A同样的闭包过期问题，同样的解法：用一个每次渲染都更新
  // 的ref间接调用，不直接把函数引用交给setInterval。
  const autoInterruptRef = useRef(null);

  async function stopSound() {
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => {});
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    // 打断/停止听书时，预取好但还没用上的下一段音频也要一并释放，
    // 不然这份资源没人管，白占着。
    if (preparedRef.current) {
      preparedRef.current.promise.then((s) => s.unloadAsync().catch(() => {})).catch(() => {});
      preparedRef.current = null;
    }
  }

  async function playOneParagraph(text, epoch, onAudioStart, presetSoundPromise) {
    let sound = null;
    const t0 = Date.now();
    if (presetSoundPromise) {
      try {
        sound = await presetSoundPromise;
        console.log(`[听书诊断] 播放段落(用预取好的，等待${Date.now() - t0}ms) voice=${voiceRef.current} rate=${rateRef.current} 字数=${text.length}`);
      } catch (e) {
        sound = null; // 预取失败就退化成现场加载，不让这段直接播放失败
      }
    }
    if (!sound) {
      const t1 = Date.now();
      ({ sound } = await Audio.Sound.createAsync(
        { uri: getTtsPlayUrl(text, voiceRef.current, rateRef.current) },
        { shouldPlay: false },
      ));
      console.log(`[听书诊断] 播放段落(现场加载，耗时${Date.now() - t1}ms) voice=${voiceRef.current} rate=${rateRef.current} 字数=${text.length}`);
    }
    if (epoch !== epochRef.current) {
      sound.unloadAsync().catch(() => {});
      return;
    }
    soundRef.current = sound;
    onAudioStart?.(); // 真正要出声了才回调——见调用处注释，打断截取的位置要跟这个对齐
    // 字幕：这一段真正开始出声，先把它切成句子、从第0句开始显示；播放
    // 状态回调里再用position/duration的比例反推大概念到第几句了。
    const sentences = splitIntoSentences(text);
    setCaptionSentences(sentences);
    setCaptionIdx(0);
    await new Promise((resolve) => {
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.isLoaded && s.durationMillis > 0 && sentences.length > 1) {
          const fraction = s.positionMillis / s.durationMillis;
          const idx = Math.max(0, Math.min(sentences.length - 1, Math.floor(fraction * sentences.length)));
          setCaptionIdx((prev) => (prev === idx ? prev : idx));
        }
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
        setParagraphProgress({ idx: pi, total: paragraphs.length });
        setIsManuallyPaused(false);
        setPhase('playing');

        // 这一段是编号列表的开头（"一、""（1）"这类），额外停顿一下再念，
        // 更接近真人朗读到编号时先顿一下的节奏。停顿期间也要认epoch，
        // 用户在这段静默里打断的话不能继续往下播。
        if (LIST_MARKER_RE.test(paragraphs[pi])) {
          await sleep(LIST_MARKER_PAUSE_MS);
          if (epoch !== epochRef.current) return;
        }

        // 取出预取好的音频——位置(ci,pi)和当时预取用的voice/rate都要跟
        // 现在完全一致才能用，任何一处对不上（比如设置面板中途改了声音）
        // 都整个丢弃，退化成现场加载，不会把过期音频当成当前这段播出来。
        let presetPromise = null;
        const prepared = preparedRef.current;
        if (prepared && prepared.ci === ci && prepared.pi === pi
            && prepared.voice === voiceRef.current && prepared.rate === rateRef.current) {
          presetPromise = prepared.promise;
          preparedRef.current = null;
        } else if (prepared) {
          prepared.promise.then((s) => s.unloadAsync().catch(() => {})).catch(() => {});
          preparedRef.current = null;
        }

        console.log(`[听书诊断] 开始加载 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段 预取命中=${!!presetPromise}`);
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
            setParagraphProgress({ idx: pi, total: paragraphs.length });
            console.log(`[听书诊断] 开始出声 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段`);
            // 这段刚出声，立刻在后台把下一段的TTS请求发出去（不等待），
            // 让加载时间跟当前段的播放时间重叠，减少段与段之间的停顿。
            const nextPi = pi + 1;
            if (nextPi < paragraphs.length) {
              const v = voiceRef.current;
              const r = rateRef.current;
              const tPrefetchStart = Date.now();
              console.log(`[听书诊断] 预取开始 第${nextPi + 1}段 字数=${paragraphs[nextPi].length}`);
              const promise = Audio.Sound.createAsync(
                { uri: getTtsPlayUrl(paragraphs[nextPi], v, r) },
                { shouldPlay: false },
              ).then(({ sound: s }) => {
                console.log(`[听书诊断] 预取完成 第${nextPi + 1}段 耗时${Date.now() - tPrefetchStart}ms`);
                return s;
              });
              preparedRef.current = { ci, pi: nextPi, voice: v, rate: r, promise };
            }
          }, presetPromise);
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

  // 真机反馈"切换声音要及时，不要等到下一部分"——已经在播的这一段音频
  // 没法中途换嗓音（已经合成好的音频文件改不了），做不到真正意义上的
  // "无缝切换"，但可以做到"立刻用新设置重新开始播这一段"，比"等这一整段
  // （可能merge了好几句、能长达十几秒）自然放完"快很多。只在真的正在
  // 朗读（phase==='playing'）时触发这个"打断重放"，其他阶段（暂停/回答
  // 中/加载中）没有"正在出声"这件事，不需要这个体验，等自然轮到下一次
  // 播放用新设置就够了，不用画蛇添足地打断。
  const prevVoiceRateRef = useRef({ voice, rate });
  useEffect(() => {
    const changed = prevVoiceRateRef.current.voice !== voice || prevVoiceRateRef.current.rate !== rate;
    prevVoiceRateRef.current = { voice, rate };
    console.log(`[听书诊断] 设置变化effect触发 changed=${changed} phase=${phase} voice=${voice} rate=${rate}`);
    if (!changed || phase !== 'playing') return;
    const { chapterIdx, paragraphIdx } = posRef.current;
    epochRef.current += 1;
    // 真机反馈"切换没有立即生效"，排查代码发现一个真实的时序bug：这里
    // 之前没有await stopSound()就紧接着调用playFrom——stopSound内部对
    // soundRef.current做stopAsync/unloadAsync是异步的，如果playFrom那边
    // 更快地把新sound对象赋给了soundRef.current，stopSound后续resolve时
    // 会错误地操作/清空新sound，而不是它本来该清理的旧sound。改成
    // 老老实实await完stopSound再启动新的playFrom，消除这个竞态。
    (async () => {
      await stopSound();
      console.log(`[听书诊断] 设置切换：停止旧音频完成，从${chapterIdx}/${paragraphIdx}用新设置重新播放`);
      playFrom(chapterIdx, paragraphIdx, epochRef.current);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, rate]);

  useEffect(() => {
    let cancelled = false;
    // 决策层这轮派发的高优先级任务：听书场景本来就是通勤/做家务这类碎片
    // 时间，锁屏/切后台必须能继续播——staysActiveInBackground是expo-av
    // 官方提供的后台播放开关，不是自己发明机制。iOS这个参数在Expo Go里
    // 不生效（官方文档原文："不适用于Expo Go的iOS，仅在独立应用中有效"），
    // 需要走eas build出真机包才能验证，这点已经如实记入开发进度记录。
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: false,
    }).catch(() => {});
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
      const wanted = (initialChapterTitle || '').trim();
      const startIdx = wanted ? filtered.findIndex((c) => c.title.trim() === wanted) : -1;
      const targetChapterIdx = startIdx >= 0 ? startIdx : 0;

      // 继续处理段落级起点：阅读器那边传来的startFraction是"当前在这一章
      // 翻到大概百分之多少"（epub.js分页信息换算出来的，不是精确到字，
      // 查证过epubjs-react-native没有对外暴露自定义WebView消息通道，做不到
      // 更精确的DOM级定位）。这里预先把目标章节的正文拉下来存进缓存，算出
      // 对应的起始段落下标，playFrom内部发现缓存已经有这一章就不会重复拉。
      const startFractionValue = typeof startFraction === 'number' && startFraction > 0 ? startFraction : 0;
      if (startFractionValue > 0) {
        const targetChapter = filtered[targetChapterIdx];
        getChapterText(bookId, targetChapter.id).then((data) => {
          if (cancelled) return;
          const paragraphs = mergeParagraphsForNarration(data.paragraphs || []);
          paragraphCacheRef.current[targetChapter.id] = paragraphs;
          const startParagraphIdx = paragraphs.length > 0
            ? Math.max(0, Math.min(paragraphs.length - 1, Math.floor(startFractionValue * paragraphs.length)))
            : 0;
          playFrom(targetChapterIdx, startParagraphIdx, epochRef.current);
        }).catch(() => {
          if (cancelled) return;
          playFrom(targetChapterIdx, 0, epochRef.current); // 算起点失败就退化成从头，不阻塞播放
        });
      } else {
        playFrom(targetChapterIdx, 0, epochRef.current);
      }
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
      if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
      if (autoListenRef.current && recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
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
    setConversation([]); // 新一次打断，对话线清空重新开始
    setPhase('paused');
  }

  // 方案B：VAD轮询检测到用户开始说话时调用的入口——只在"正在朗读"这个
  // phase、且没有开静音的时候真正触发。跟handleInterrupt的判断条件看起来
  // 重复（handleInterrupt自己也会检查phase），但这里必须自己先判断一次：
  // handsFreeMuted这个开关只应该拦在"要不要触发"这一步，不应该改
  // handleInterrupt本身的行为（手动按钮打断不受静音影响，静音只管免提
  // 这一条自动触发的路径）。触发之后紧接着调用方案A已经写好的
  // startAutoListen——免提打断解决的是"不用碰按钮就能让朗读停下来"，
  // 用户实际要问的问题，复用方案A那套"停下来之后自动监听几秒"的逻辑
  // 去捕获，没有另外发明一套新的语音捕获路径。
  function handleAutoInterrupt() {
    if (phase !== 'playing') return;
    if (handsFreeMuted) return;
    handleInterrupt();
    startAutoListen();
  }
  useEffect(() => { autoInterruptRef.current = handleAutoInterrupt; });

  // 决策层这轮派发：连续追问改成"对话式"UI——之前点"继续追问"会跳回
  // 一个空白提问页，之前问过的内容全部看不见，用户反馈"像打断感"。改成
  // 用户提问和AI回答都追加进conversation这个数组，界面上渲染成持续的
  // 对话线（见render部分），不再有单独的"post-answer二次确认"这个phase——
  // 回答完直接回到paused（输入框重新可用），"继续追问"就是接着在同一个
  // 输入框里打字，不需要额外点一次"继续追问"按钮先跳转。
  function handleAsk() {
    const q = question.trim();
    if (!q) return;
    setQuestion('');
    // 用户的提问立刻追加进对话线（不等AI回答），这样屏幕上马上能看到
    // "我刚问的问题"，符合真实聊天的即时反馈感，不用等好几秒才看到内容。
    setConversation((prev) => [...prev, { role: 'user', content: q }]);
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
        history: conversation,
      },
      {
        onDelta: (delta) => { fullAnswer += delta; },
        onDone: async (answer) => {
          abortAskRef.current = null;
          setConversation((prev) => [...prev, { role: 'assistant', content: answer }]);
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
            question: q, answer, selection: capturedText, cfiRange: fakeCfi, style: 'simple',
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
          // 回答播完直接回到paused（输入框重新激活），不再经过单独的
          // "要继续追问还是继续听书"二次确认页——"继续听书"链接在对话线
          // 下方一直可点，"继续追问"就是接着在输入框里打字。
          if (epoch === epochRef.current) {
            setPhase('paused');
            // 方案A：这一刻是"AI刚回答完、等用户下一步"的等待窗口，静默
            // 开一次麦克风监听几秒——用户说"继续"这类词就自动接回朗读，
            // 不用点按钮。只在这个"回答完"路径触发，不包括handleInterrupt
            // 那个"刚打断、还没问过任何问题"的paused（那个阶段用户预期
            // 是要主动问点什么，不是"继续"）。
            startAutoListen();
          }
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
    abortAskRef.current?.(); // 对话线下方随时可点"继续听书"，包括AI还在想的时候，这里先把没结束的提问请求断掉
    abortAskRef.current = null;
    // 方案A的自动监听如果还在录音窗口内（比如用户手动点了"继续听书"，
    // 没等自动监听那几秒跑完），这里主动停掉丢弃——不需要它的识别结果了，
    // 用户已经用手动方式表达了"继续"这个意图，避免几秒后识别结果才回来、
    // 对着已经在播放的状态又误触发一次重复的handleContinue。
    if (autoListenRef.current) {
      autoListenRef.current = false;
      if (autoListenTimerRef.current) {
        clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
      const rec = recordingRef.current;
      recordingRef.current = null;
      setIsRecording(false);
      setRecordingStatus('');
      if (rec) {
        rec.stopAndUnloadAsync().catch(() => {});
        Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
      }
    }
    setConversation([]); // 回到听书主线，这一轮打断的对话线结束
    const { chapterIdx, paragraphIdx } = posRef.current;
    playFrom(chapterIdx, paragraphIdx, epochRef.current);
  }

  function handleStopListening() {
    epochRef.current += 1;
    stopSound();
    navigation.goBack();
  }

  // 任务1新增：设计稿的播放/暂停按钮是"轻量暂停"，跟"打断"（进提问模式）
  // 是两个不同的动作——暂停只是把当前已经加载好的音频停住，不清空
  // capturedText、不清空对话线、不改变phase，恢复时接着播这同一段，不用
  // 重新合成语音。直接操作soundRef.current这个已有的Sound实例
  // （pauseAsync/playAsync是expo-av自带的、对已加载音频安全的操作），
  // 不新增phase值，不碰2号负责的录音/VAD状态。
  function togglePlayPause() {
    if (!soundRef.current) return;
    if (isManuallyPaused) {
      soundRef.current.playAsync().catch(() => {});
      setIsManuallyPaused(false);
    } else {
      soundRef.current.pauseAsync().catch(() => {});
      setIsManuallyPaused(true);
    }
  }

  // 上一章/下一章：直接复用已有的playFrom从新章节第0段开始，不是新逻辑，
  // 只是提供了一个从章节任意位置跳转的UI入口（之前只能从头到尾顺序播）。
  function goToAdjacentChapter(delta) {
    const chapters = chaptersRef.current;
    const targetIdx = posRef.current.chapterIdx + delta;
    if (targetIdx < 0 || targetIdx >= chapters.length) return;
    epochRef.current += 1;
    stopSound();
    setIsManuallyPaused(false);
    playFrom(targetIdx, 0, epochRef.current);
  }

  function jumpToChapter(idx) {
    setShowChapterPicker(false);
    if (idx === posRef.current.chapterIdx) return;
    epochRef.current += 1;
    stopSound();
    setIsManuallyPaused(false);
    playFrom(idx, 0, epochRef.current);
  }

  // 音色：设计稿"点哪个标签就能直接改"——单点直接切到列表里下一个候选，
  // 不用先打开一个选择面板才能选，跟章节/语速（数值范围不适合单点直接改）
  // 特意做成不同的交互，语速改成点开小面板里放已有的连续滑动条。
  function cycleVoice() {
    const idx = VOICE_OPTIONS.findIndex((o) => o.value === voice);
    const next = VOICE_OPTIONS[(idx + 1) % VOICE_OPTIONS.length];
    setVoice(next.value);
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
    if (autoListenTimerRef.current) {
      clearTimeout(autoListenTimerRef.current);
      autoListenTimerRef.current = null;
    }
    const wasAutoListen = autoListenRef.current;
    autoListenRef.current = false;
    const epochAtStart = epochRef.current;
    setIsRecording(false);
    setIsTranscribing(!wasAutoListen); // 自动监听窗口不显示"识别中"这个强打扰的状态，手动录音保留原样
    if (!wasAutoListen) setRecordingStatus('识别中…');
    try {
      const rec = recordingRef.current;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      recordingRef.current = null;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const text = await transcribeAudio(uri, FileSystem.uploadAsync, FileSystem.FileSystemUploadType);
      // epoch变了（比如识别这几秒里用户又打断了别的地方）说明这轮监听已经
      // 过期，识别结果不再适用，直接丢弃不生效。注意这里不检查phase状态——
      // finishRecording是异步setTimeout回调里调用的，函数本身在闭包创建
      // 那一刻就把phase锁定了，用户手动点"继续听书"之后phase早就变了，
      // 这个闭包却读不到最新值（React经典的闭包过期问题），检查了也没用、
      // 反而会误判。真正防止"手动点了继续听书、几秒后自动监听结果又重复
      // 触发一次"这种情况的，是handleContinue自己主动取消掉还在进行中的
      // 自动监听（见下面），不是靠这里读phase判断。
      if (epochAtStart !== epochRef.current) return;
      if (wasAutoListen) {
        if (isContinueVoiceCommand(text)) {
          handleContinue();
        } else if (text?.trim() && !question.trim()) {
          // 不是"继续"指令，但确实识别出内容了——大概率是用户没点麦克风
          // 按钮就直接开口问了问题，顺手填进输入框（跟手动识别体验一致），
          // 不静默丢弃；如果用户这几秒里已经自己在输入框打了字，不要用
          // 识别结果覆盖手打的内容。
          setQuestion(text.trim());
        }
        return;
      }
      if (text?.trim()) {
        setQuestion(text.trim());
        setRecordingStatus('识别完成 — 确认后点提问');
      } else {
        setRecordingStatus('未识别到内容，请重试');
      }
    } catch (e) {
      if (!wasAutoListen) setRecordingStatus(`识别失败：${e.message}`);
    } finally {
      setIsTranscribing(false);
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

  // 方案A：AI回答播完、回到paused等对话式输入这一刻自动调用——静默尝试
  // 开一次麦克风监听几秒，用户不用做任何操作。任何一步失败（没有权限、
  // 已经在录音中）都直接放弃，不弹错误提示——这本来就是一个"锦上添花"
  // 的静默功能，不是用户主动发起的操作，不能因为它失败去打扰用户，manual
  // 的按钮路径完全不受影响，用户随时可以手动点麦克风/打字。
  async function startAutoListen() {
    if (isRecording || startingRecordingRef.current) return;
    startingRecordingRef.current = true;
    try {
      const { status: perm } = await Audio.getPermissionsAsync();
      if (perm !== 'granted') return; // 静默放弃，不主动弹权限请求打断听书体验
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      autoListenRef.current = true;
      setIsRecording(true);
      setRecordingStatus('（可以直接说"继续"接回朗读，或者直接问问题）');
      autoListenTimerRef.current = setTimeout(() => { finishRecording(); }, AUTO_LISTEN_WINDOW_MS);
    } catch (e) {
      autoListenRef.current = false;
      // 静默失败，不设置recordingStatus——手动路径不受影响
    } finally {
      startingRecordingRef.current = false;
    }
  }

  // 方案B：每300ms读一次pc1（发送本地麦克风流那一端）的统计数据，找音量
  // 字段——跟WebrtcAecTestScreen.js里验证过的做法一致，阈值/轮询间隔也是
  // 同一套真机校准过的数值。连续VAD_SUSTAIN_POLLS次超过阈值才算真的开始
  // 说话（防止瞬间噪音误触发），触发后要等音量先跌回阈值以下才会重新
  // 允许下一次触发，不会同一段话持续说话期间反复触发好几次打断。
  function startVadPolling(pc) {
    stopVadPollingOnly();
    vadSustainCountRef.current = 0;
    vadSpeakingRef.current = false;
    vadPollTimerRef.current = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        let level = null;
        for (const report of stats.values()) {
          if (typeof report.audioLevel === 'number') { level = report.audioLevel; break; }
        }
        if (level === null) return;
        if (level >= VAD_SPEECH_THRESHOLD) {
          vadSustainCountRef.current += 1;
          if (!vadSpeakingRef.current && vadSustainCountRef.current >= VAD_SUSTAIN_POLLS) {
            vadSpeakingRef.current = true;
            autoInterruptRef.current?.();
          }
        } else {
          vadSustainCountRef.current = 0;
          vadSpeakingRef.current = false;
        }
      } catch (e) {
        // 单次读取失败不影响下一轮轮询，不打断听书体验，也不弹提示
      }
    }, VAD_POLL_INTERVAL_MS);
  }

  function stopVadPollingOnly() {
    if (vadPollTimerRef.current) {
      clearInterval(vadPollTimerRef.current);
      vadPollTimerRef.current = null;
    }
  }

  // 方案B：开启免提打断——沿用AEC技术验证spike里验证过的连接方式（本机
  // 内部pc1↔pc2回环，不需要真实信令服务器），跟AEC测试页唯一的关键区别：
  // pc2收到的远端音轨要静音（track.enabled=false），不然react-native-webrtc
  // 会自动把这条音轨路由到设备当前音频输出播放出来（AEC测试页就是靠这个
  // 判断有没有回声），免提打断场景绝对不能让用户自己的说话声/环境声被
  // 循环播出来变成刺耳的实时回音——这里只是要拿一个真正建立连接的
  // RTCPeerConnection来读音量统计，不需要真的听到这条音轨内容。
  async function startHandsFreeVad() {
    const { mediaDevices, RTCPeerConnection } = require('react-native-webrtc');
    const InCallManager = require('react-native-incall-manager').default;
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        { title: '麦克风权限', message: '免提打断需要持续访问麦克风，用来判断你有没有在说话', buttonPositive: '允许' },
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        setHandsFreeStatus('麦克风权限被拒绝，免提打断无法开启');
        setHandsFreeEnabled(false);
        return;
      }
    }
    try {
      InCallManager.start({ media: 'audio' });
      InCallManager.setForceSpeakerphoneOn(true);
      vadInCallManagerRef.current = InCallManager;

      const stream = await mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      vadStreamRef.current = stream;

      const pc1 = new RTCPeerConnection({});
      const pc2 = new RTCPeerConnection({});
      vadPc1Ref.current = pc1;
      vadPc2Ref.current = pc2;
      stream.getTracks().forEach((track) => pc1.addTrack(track, stream));

      pc1.addEventListener('icecandidate', (e) => {
        if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {});
      });
      pc2.addEventListener('icecandidate', (e) => {
        if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {});
      });
      pc2.addEventListener('track', (e) => {
        if (e.track) e.track.enabled = false; // 静音远端播放，见上面函数注释
      });
      pc2.addEventListener('iceconnectionstatechange', () => {
        if (pc2.iceConnectionState === 'connected' || pc2.iceConnectionState === 'completed') {
          setHandsFreeStatus('免提监听中');
          startVadPolling(pc1);
        }
      });

      const offer = await pc1.createOffer({});
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(pc1.localDescription);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(pc2.localDescription);
    } catch (e) {
      setHandsFreeStatus(`免提打断启动失败：${e.message}`);
      setHandsFreeEnabled(false);
    }
  }

  function stopHandsFreeVad() {
    stopVadPollingOnly();
    vadStreamRef.current?.getTracks().forEach((t) => t.stop());
    vadPc1Ref.current?.close();
    vadPc2Ref.current?.close();
    vadInCallManagerRef.current?.stop();
    vadStreamRef.current = null;
    vadPc1Ref.current = null;
    vadPc2Ref.current = null;
    vadInCallManagerRef.current = null;
    setHandsFreeStatus('');
  }

  // 免提开关变化时连接/断开——开关本身之外，退出这个屏幕（组件卸载）也
  // 要确保断开，不能让WebRTC连接和InCallManager的通话音频模式在离开
  // 听书页之后还占着，会影响App其它地方的正常音频行为。
  useEffect(() => {
    if (handsFreeEnabled) {
      setHandsFreeStatus('连接中…');
      startHandsFreeVad();
    } else {
      stopHandsFreeVad();
    }
    return () => { stopHandsFreeVad(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFreeEnabled]);

  // 任务1：设计稿里灯芯轨迹环/光尘/呼吸光晕这套装饰动画，只在"朗读中"
  // （narrating视图可见）跑，打断进对话视图或者非playing阶段就停掉，
  // 省电也避免看不见的地方还在白跑动画。用RN核心自带的Animated，不引入
  // 新依赖——呼吸缩放、轨迹环旋转、三层脉冲光环（错峰启动）都是循环动画，
  // reduce-motion这类系统级无障碍设置RN的Animated模块目前没有直接对应的
  // 检测API，这次没有做适配，如实记录这个缺口。
  const breatheAnim = useRef(new Animated.Value(0)).current;
  const orbitAnim = useRef(new Animated.Value(0)).current;
  const ringAnims = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  const isNarratingVisible = phase === 'playing' || phase === 'loading-chapter';
  const isOrbAnimating = isNarratingVisible && !isManuallyPaused;
  useEffect(() => {
    if (!isOrbAnimating) return undefined;
    const breatheLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breatheAnim, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(breatheAnim, { toValue: 0, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    const orbitLoop = Animated.loop(
      Animated.timing(orbitAnim, { toValue: 1, duration: 14000, easing: Easing.linear, useNativeDriver: true }),
    );
    breatheLoop.start();
    orbitLoop.start();
    const ringLoops = ringAnims.map((anim, i) => {
      anim.setValue(0);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.delay(i * 700),
          Animated.timing(anim, { toValue: 1, duration: 2600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]),
      );
      loop.start();
      return loop;
    });
    return () => {
      breatheLoop.stop();
      orbitLoop.stop();
      ringLoops.forEach((l) => l.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOrbAnimating]);

  const chapter = chaptersRef.current[posRef.current.chapterIdx] || {};
  const inConversation = phase === 'paused' || phase === 'thinking' || phase === 'answering';
  const currentCaption = captionSentences[captionIdx] || '';

  const voiceLabel = (VOICE_OPTIONS.find((o) => o.value === voice)?.label || voice).replace(/（.*）/, '');
  const showLoadingIndicator = phase === 'loading-book';

  return (
    <View style={[styles.stage, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {showLoadingIndicator && (
        <View style={styles.centerBox}><ActivityIndicator color={LISTEN_THEME.ember} /></View>
      )}

      {phase === 'error' && (
        <View style={styles.centerBox}>
          <Text style={styles.errorText}>{errorMsg}</Text>
          <TouchableOpacity style={styles.primaryPill} onPress={handleStopListening}>
            <Text style={styles.primaryPillText}>返回</Text>
          </TouchableOpacity>
        </View>
      )}

      {phase === 'done' && (
        <View style={styles.centerBox}>
          <Text style={styles.doneText}>这本书听完了</Text>
          <TouchableOpacity style={styles.primaryPill} onPress={handleStopListening}>
            <Text style={styles.primaryPillText}>返回</Text>
          </TouchableOpacity>
        </View>
      )}

      {!showLoadingIndicator && phase !== 'error' && phase !== 'done' && (
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.bar}>
            <TouchableOpacity
              onPress={inConversation ? handleContinue : handleStopListening}
              style={styles.iconBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <IconChevronLeft color={LISTEN_THEME.paperDim} size={20} strokeWidth={2} />
            </TouchableOpacity>
            <View style={styles.crumb}>
              <Text style={styles.crumbBook} numberOfLines={1}>{bookTitle}</Text>
              <Text style={styles.crumbChap} numberOfLines={1}>{chapterTitle || chapter.title || ''}</Text>
            </View>
            <View style={{ width: 30 }} />
          </View>

          {/* 设计稿：音色/语速/章节从齿轮菜单挪到常驻的三个chip，点哪个
              标签就直接改，不用先打开菜单。这一行在朗读/对话两种视图下
              都常驻显示（设计稿原文里这一行不受.in-conversation影响）。 */}
          <View style={styles.quickSettings}>
            <TouchableOpacity style={styles.settingChip} onPress={() => setShowChapterPicker(true)}>
              <IconList color={LISTEN_THEME.paperDim} size={13} strokeWidth={2} />
              <Text style={styles.settingChipText} numberOfLines={1}>{chapterTitle || chapter.title || '章节'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.settingChip} onPress={cycleVoice}>
              <IconVolume color={LISTEN_THEME.paperDim} size={13} strokeWidth={2} />
              <Text style={styles.settingChipText}>{voiceLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.settingChip} onPress={() => setShowRatePicker(true)}>
              <IconBolt color={LISTEN_THEME.paperDim} size={13} strokeWidth={2} />
              <Text style={styles.settingChipText}>{rateStrToMultiplier(rate).toFixed(2)}×</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.mainStage}>
            {!inConversation ? (
              <View style={styles.narratingView}>
                <View style={styles.orbZone}>
                  {/* 光尘：设计稿是9秒循环的漂浮小点，这版简化成静态半透明
                      光点（没做drift动画），呼吸光晕/轨迹环/脉冲光环三个
                      主要动效已经用RN Animated做了，光尘这个次要装饰先
                      简化，如实标注不是漏做。 */}
                  {MOTE_POSITIONS.map((m, i) => (
                    <View key={i} style={[styles.mote, { left: m.left, top: m.top }]} />
                  ))}
                  <Animated.View
                    style={[
                      styles.orbit,
                      { transform: [{ rotate: orbitAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] },
                    ]}
                  >
                    <View style={styles.orbitMote} />
                  </Animated.View>
                  {ringAnims.map((anim, i) => (
                    <Animated.View
                      key={i}
                      style={[
                        styles.ring,
                        {
                          width: anim.interpolate({ inputRange: [0, 1], outputRange: [92, 220] }),
                          height: anim.interpolate({ inputRange: [0, 1], outputRange: [92, 220] }),
                          borderRadius: anim.interpolate({ inputRange: [0, 1], outputRange: [46, 110] }),
                          opacity: anim.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 0.55, 0] }),
                        },
                      ]}
                    />
                  ))}
                  <Animated.View
                    style={[
                      styles.orb,
                      { transform: [{ scale: breatheAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) }] },
                    ]}
                  >
                    {phase === 'loading-chapter' ? (
                      <ActivityIndicator color="#2a1a08" />
                    ) : (
                      <TouchableOpacity
                        onPress={togglePlayPause}
                        hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                      >
                        {isManuallyPaused && <IconPlayerPlay color="#2a1a08" size={30} />}
                      </TouchableOpacity>
                    )}
                  </Animated.View>
                </View>
                <View style={styles.captionZone}>
                  <Text style={styles.captionText}>
                    {phase === 'loading-chapter' ? '正在加载章节…' : (currentCaption || '…')}
                  </Text>
                  {captionSentences.length > 1 && phase === 'playing' && (
                    <Text style={styles.captionCount}>句 {captionIdx + 1}/{captionSentences.length}</Text>
                  )}
                </View>
              </View>
            ) : (
              <ScrollView style={styles.conversationView} contentContainerStyle={styles.chatBody}>
                <View style={styles.contextChip}>
                  <Text style={styles.contextChipLabel}>你打断时正讲到</Text>
                  <Text style={styles.contextChipText}>{capturedText}</Text>
                </View>

                <View style={styles.saveHighlightRow}>
                  <Switch value={saveAsHighlight} onValueChange={setSaveAsHighlight} />
                  <Text style={styles.saveHighlightText}>把这段保存为划线</Text>
                </View>

                {conversation.map((msg, idx) => (
                  <View key={idx} style={[styles.bubble, msg.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}>
                    <Text style={msg.role === 'user' ? styles.bubbleUserText : styles.bubbleAiText}>{msg.content}</Text>
                  </View>
                ))}

                {phase === 'thinking' && (
                  <View style={styles.thinkingRow}>
                    <ActivityIndicator color={LISTEN_THEME.ember} size="small" />
                    <Text style={styles.thinkingText}>AI正在思考…</Text>
                  </View>
                )}
                {phase === 'answering' && (
                  <View style={styles.thinkingRow}>
                    <ActivityIndicator color={LISTEN_THEME.ember} size="small" />
                    <Text style={styles.thinkingText}>AI正在朗读回答…</Text>
                  </View>
                )}

                {conversation.length > 0 && phase === 'paused' && (
                  <View style={styles.resumeRow}>
                    <TouchableOpacity style={styles.resumeBtn} onPress={handleContinue}>
                      <Text style={styles.resumeBtnText}>继续听下去</Text>
                    </TouchableOpacity>
                    <Text style={styles.continueHint}>或者接着追问</Text>
                  </View>
                )}
                {!!recordingStatus && !isTranscribing && (
                  <Text style={styles.recordingStatus}>{recordingStatus}</Text>
                )}
              </ScrollView>
            )}
          </View>

          {/* 设计稿：进度条/播放控制不管在朗读还是对话视图下都原地不动。
              这套架构没有整本书预先量好的总时长（每段TTS现场合成），
              进度条做成"当前章节第几段/共几段"，拖动＝跳到那一段，不是
              设计稿demo里mm:ss那种时间轴——如实说明这是跟设计稿字面的
              一个偏差，反馈环节会跟决策层说清楚。 */}
          <View style={styles.controls}>
            <View style={styles.progressWrap}>
              <Slider
                style={styles.progressSlider}
                minimumValue={0}
                maximumValue={Math.max(paragraphProgress.total - 1, 0)}
                step={1}
                value={Math.min(paragraphProgress.idx, Math.max(paragraphProgress.total - 1, 0))}
                minimumTrackTintColor={LISTEN_THEME.ember}
                maximumTrackTintColor="rgba(255,255,255,0.12)"
                thumbTintColor={LISTEN_THEME.emberBright}
                disabled={paragraphProgress.total <= 1 || inConversation}
                onSlidingComplete={(v) => {
                  const idx = Math.round(v);
                  if (idx === paragraphProgress.idx) return;
                  epochRef.current += 1;
                  stopSound();
                  setIsManuallyPaused(false);
                  playFrom(posRef.current.chapterIdx, idx, epochRef.current);
                }}
              />
              <Text style={styles.progressLabelText}>
                {paragraphProgress.total ? `第 ${paragraphProgress.idx + 1} / ${paragraphProgress.total} 段` : ''}
              </Text>
            </View>

            <View style={styles.transport}>
              <TouchableOpacity style={styles.transportIconBtn} onPress={() => goToAdjacentChapter(-1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconPlayerTrackPrev color={LISTEN_THEME.paperDim} size={20} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.transportPlayBtn}
                onPress={togglePlayPause}
                disabled={phase === 'loading-chapter'}
              >
                {isManuallyPaused
                  ? <IconPlayerPlay color={LISTEN_THEME.emberBright} size={22} strokeWidth={2} />
                  : <IconPlayerPause color={LISTEN_THEME.emberBright} size={22} strokeWidth={2} />}
              </TouchableOpacity>
              <TouchableOpacity style={styles.transportIconBtn} onPress={() => goToAdjacentChapter(1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconPlayerTrackNext color={LISTEN_THEME.paperDim} size={20} strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {!inConversation ? (
              <>
                <View style={styles.askZone}>
                  {!handsFreeEnabled ? (
                    <TouchableOpacity style={styles.interruptPill} onPress={handleInterrupt}>
                      <Text style={styles.interruptPillText}>打断，我想问问</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.hfLive}>
                      <Text style={styles.hfLiveTag}>
                        {handsFreeStatus === '连接中…' ? '连接中…' : (handsFreeMuted ? '已静音 · 朗读继续' : '正在聆听 · 随时开口')}
                      </Text>
                      <TouchableOpacity style={styles.muteIconBtn} onPress={() => setHandsFreeMuted((v) => !v)}>
                        {handsFreeMuted
                          ? <IconVolumeOff color={LISTEN_THEME.paperDim} size={13} strokeWidth={2} />
                          : <IconVolume color={LISTEN_THEME.paperDim} size={13} strokeWidth={2} />}
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                <TouchableOpacity
                  style={[styles.micToggle, handsFreeEnabled && styles.micToggleOn]}
                  onPress={() => setHandsFreeEnabled((v) => !v)}
                >
                  {handsFreeEnabled
                    ? <IconMicrophone color={LISTEN_THEME.emberBright} size={18} strokeWidth={2} />
                    : <IconMicrophoneOff color={LISTEN_THEME.inkSoft} size={18} strokeWidth={2} />}
                </TouchableOpacity>
                <Text style={styles.micLabel}>
                  {handsFreeEnabled ? '免提已开启，随时说话' : '点击开始提问'}
                </Text>
              </>
            ) : (
              phase === 'paused' && (
                <View style={styles.inputBar}>
                  <TouchableOpacity
                    style={[styles.micBtnRound, isRecording && styles.micBtnRoundActive]}
                    onPress={toggleRecording}
                  >
                    <IconMicrophone color={isRecording ? '#2a1a08' : LISTEN_THEME.paperDim} size={15} strokeWidth={2} />
                  </TouchableOpacity>
                  {isTranscribing ? (
                    <View style={[styles.inputField, styles.inputFieldTranscribing]}>
                      <ActivityIndicator size="small" color={LISTEN_THEME.ember} />
                      <Text style={styles.transcribingText}>正在识别语音…</Text>
                    </View>
                  ) : (
                    <TextInput
                      style={styles.inputField}
                      placeholder={conversation.length ? '继续追问…' : '再问一句…'}
                      placeholderTextColor={LISTEN_THEME.inkSoft}
                      value={question}
                      onChangeText={setQuestion}
                    />
                  )}
                  <TouchableOpacity
                    style={[styles.sendBtn, !question.trim() && styles.sendBtnOff]}
                    onPress={handleAsk}
                    disabled={!question.trim()}
                  >
                    <IconSend2 color="#2a1a08" size={15} strokeWidth={2} />
                  </TouchableOpacity>
                </View>
              )
            )}
          </View>
        </KeyboardAvoidingView>
      )}

      {/* 章节选择：设计稿说"点开是App已有的多层目录弹层，不用重新做一套"，
          但ListenScreen手上只有chaptersRef这份扁平列表（没有ReaderScreen
          那边epub.js渲染出来的嵌套toc数据），两边数据源不是同一份，做不到
          真的复用同一个组件实例——这里做的是贴这次暗色视觉语言的平级列表
          弹层，是跟设计稿字面要求的已知偏差，反馈环节会跟决策层说清楚。 */}
      <Modal visible={showChapterPicker} animationType="fade" transparent onRequestClose={() => setShowChapterPicker(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowChapterPicker(false)}>
          <View style={styles.pickerSheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>选择章节</Text>
            <FlatList
              data={chaptersRef.current}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item, index }) => (
                <TouchableOpacity style={styles.pickerRow} onPress={() => jumpToChapter(index)}>
                  <Text
                    style={[styles.pickerRowText, index === posRef.current.chapterIdx && styles.pickerRowTextActive]}
                    numberOfLines={1}
                  >
                    {item.title}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showRatePicker} animationType="fade" transparent onRequestClose={() => setShowRatePicker(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowRatePicker(false)}>
          <View style={styles.rateSheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>语速 {rateDisplay.toFixed(2)}×</Text>
            <Slider
              style={styles.rateSliderDark}
              minimumValue={RATE_MIN}
              maximumValue={RATE_MAX}
              step={RATE_STEP}
              value={rateStrToMultiplier(rate)}
              minimumTrackTintColor={LISTEN_THEME.ember}
              maximumTrackTintColor="rgba(255,255,255,0.15)"
              thumbTintColor={LISTEN_THEME.emberBright}
              onValueChange={setRateDisplay}
              onSlidingComplete={(v) => setRate(rateMultiplierToStr(v))}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// 光尘位置：抄设计稿inline style里的百分比坐标，5个点，不做逐点drift动画
// （见上面渲染处注释，这是有意简化的一块）。
const MOTE_POSITIONS = [
  { left: '22%', top: '20%' },
  { left: '78%', top: '30%' },
  { left: '15%', top: '70%' },
  { left: '85%', top: '68%' },
  { left: '50%', top: '14%' },
];

const T = LISTEN_THEME;

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: T.ink },
  flex: { flex: 1 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  errorText: { fontSize: 14, textAlign: 'center', color: T.paperDim },
  doneText: { fontSize: 18, fontWeight: '600', color: T.paper },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 4,
  },
  iconBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  crumb: { flex: 1, alignItems: 'center' },
  crumbBook: { fontSize: 15, color: T.paper, fontWeight: '500' },
  crumbChap: { fontSize: 10.5, color: T.inkSoft, marginTop: 3 },

  quickSettings: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 4 },
  settingChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 0.5, borderColor: T.inkSoft,
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 130,
  },
  settingChipText: { fontSize: 11, color: T.paperDim },

  mainStage: { flex: 1 },
  narratingView: { flex: 1 },
  orbZone: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mote: { position: 'absolute', width: 3, height: 3, borderRadius: 1.5, backgroundColor: T.ember, opacity: 0.35 },
  orbit: {
    position: 'absolute', width: 168, height: 168, borderRadius: 84,
    borderWidth: 0.5, borderColor: 'rgba(226,150,58,0.28)',
    alignItems: 'center', justifyContent: 'flex-start',
  },
  orbitMote: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: T.emberBright, marginTop: -3,
    shadowColor: T.emberBright, shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
  },
  ring: { position: 'absolute', borderWidth: 1, borderColor: T.emberDim },
  orb: {
    width: 92, height: 92, borderRadius: 46, backgroundColor: T.ember,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: T.ember, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  captionZone: { paddingHorizontal: 30, paddingBottom: 8, minHeight: 90, alignItems: 'center', justifyContent: 'flex-start' },
  captionText: { fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }), fontSize: 16.5, lineHeight: 27, textAlign: 'center', color: T.paper },
  captionCount: { fontSize: 9, color: T.inkSoft, marginTop: 6, letterSpacing: 0.5 },

  conversationView: { flex: 1 },
  chatBody: { padding: 16, paddingBottom: 8, gap: 14 },
  contextChip: {
    backgroundColor: 'rgba(226,150,58,0.08)', borderLeftWidth: 2, borderLeftColor: T.emberDim,
    borderRadius: 4, padding: 10,
  },
  contextChipLabel: { fontSize: 9.5, letterSpacing: 0.5, color: T.ember, marginBottom: 4, textTransform: 'uppercase' },
  contextChipText: { fontSize: 12, lineHeight: 19, color: T.paperDim },
  bubble: { maxWidth: '82%', paddingHorizontal: 13, paddingVertical: 10, borderRadius: 16 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: T.emberDim, borderBottomRightRadius: 4 },
  bubbleAi: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)', borderBottomLeftRadius: 4 },
  bubbleUserText: { color: T.paper, fontSize: 13, lineHeight: 21 },
  bubbleAiText: { color: T.paper, fontSize: 13, lineHeight: 21 },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  thinkingText: { fontSize: 13, color: T.paperDim },
  resumeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  resumeBtn: {
    backgroundColor: 'rgba(111,160,136,0.12)', borderWidth: 0.5, borderColor: 'rgba(111,160,136,0.4)',
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
  },
  resumeBtnText: { fontSize: 12.5, color: T.jade },
  continueHint: { fontSize: 11.5, color: T.inkSoft },
  saveHighlightRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  saveHighlightText: { fontSize: 12.5, color: T.paperDim },
  recordingStatus: { fontSize: 11.5, color: T.inkSoft },

  controls: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 20, gap: 14 },
  progressWrap: { gap: 5 },
  progressSlider: { width: '100%', height: 28 },
  progressLabelText: { fontSize: 10.5, color: T.inkSoft, textAlign: 'center', fontVariant: ['tabular-nums'] },

  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28 },
  transportIconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  transportPlayBtn: {
    width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(226,150,58,0.14)', borderWidth: 1, borderColor: 'rgba(226,150,58,0.35)',
  },

  askZone: { minHeight: 34, alignItems: 'center', justifyContent: 'center' },
  interruptPill: {
    backgroundColor: T.emberBright, paddingHorizontal: 30, paddingVertical: 12, borderRadius: 999,
  },
  interruptPillText: { color: '#2a1a08', fontSize: 13.5, fontWeight: '500' },
  hfLive: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hfLiveTag: { fontSize: 10.5, color: T.emberBright, letterSpacing: 0.5 },
  muteIconBtn: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },

  micToggle: {
    alignSelf: 'center', width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.inkSoft,
  },
  micToggleOn: { backgroundColor: 'rgba(226,150,58,0.14)', borderColor: T.ember },
  micLabel: { fontSize: 9, color: T.inkSoft, textAlign: 'center', letterSpacing: 0.5 },

  inputBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputField: {
    flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 9, fontSize: 12.5, color: T.paper,
  },
  inputFieldTranscribing: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  transcribingText: { fontSize: 12, color: T.paperDim },
  micBtnRound: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  micBtnRoundActive: { backgroundColor: T.emberBright },
  sendBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: T.ember },
  sendBtnOff: { opacity: 0.4 },

  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  pickerSheet: { maxHeight: '65%', backgroundColor: T.dusk, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18 },
  pickerTitle: { fontSize: 15, fontWeight: '600', color: T.paper, marginBottom: 12, textAlign: 'center' },
  pickerRow: { paddingVertical: 13, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.08)' },
  pickerRowText: { fontSize: 14, color: T.paperDim },
  pickerRowTextActive: { color: T.emberBright, fontWeight: '600' },
  rateSheet: { backgroundColor: T.dusk, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 22, paddingBottom: 36 },
  rateSliderDark: { width: '100%', height: 32, marginTop: 12 },
});
