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
  Animated, Easing, Modal,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import Slider from '@react-native-community/slider';
import {
  IconChevronLeft, IconList, IconVolume, IconBolt,
  IconPlayerTrackPrevFilled, IconPlayerTrackNextFilled,
  IconPlayerPlayFilled, IconPlayerPauseFilled,
  IconMicrophone, IconMicrophoneOff, IconSend, IconDropletFilled,
} from '@tabler/icons-react-native';
import {
  getBookContext, getChapterText, getTtsPlayUrl, transcribeAudio,
  streamAsk, saveHighlight, saveQaHistory, classifyIntent,
} from '../lib/api';
import { useAuthGate } from '../lib/authGate';

// 接替1号任务1：听书界面视觉改造，精确规格来自决策层定稿的设计稿
// docs/设计稿/听书界面-设计稿.html——颜色/间距/圆角这些数值直接照抄那份
// 文件里的CSS变量和px值，不是凭感觉重新设计。这套"沉光共读"配色是专门
// 给听书这一个页面用的暗色调，跟App其它页面common的theme.js（暖纸古风）
// 是两套独立的视觉语言，不共用、不修改theme.js——设计稿本身也只覆盖
// 听书这一个页面，不是全局换肤。
const EMBER = {
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
  screenBg1: '#2c2015',
  screenBg2: '#1c130d',
  screenBg3: '#150e09',
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
const CONTINUE_READING_VOICE_PATTERNS = ['继续读', '继续念', '继续听', '接着读', '接着念', '接着听', '往下读', '往下念', '读下去', '念下去'];
const FOLLOW_UP_VOICE_PATTERNS = ['继续解释', '继续讲', '继续说', '接着解释', '接着讲', '再讲讲', '展开讲'];
function isContinueVoiceCommand(text) {
  const t = (text || '').trim();
  if (!t || t.length > 14) return false;
  if (FOLLOW_UP_VOICE_PATTERNS.some((p) => t.includes(p))) return false;
  return CONTINUE_VOICE_PATTERNS.some((p) => t.includes(p))
    || CONTINUE_READING_VOICE_PATTERNS.some((p) => t.includes(p));
}

// 免提的语义过滤是为了挡电视/旁人闲聊，不应该把用户已经清楚说出来的
// 问句吞掉。DeepSeek二分类偶尔偏保守时，先用本地的显式问句特征兜底。
const QUESTION_VOICE_PATTERNS = [
  '什么', '为什么', '怎么', '如何', '哪里', '哪儿', '吗', '呢',
  '意思', '解释', '讲一下', '讲讲', '说一下', '?', '？',
];
function looksLikeHandsFreeQuestion(text) {
  const t = (text || '').trim();
  if (!t || t.length > 80) return false;
  return QUESTION_VOICE_PATTERNS.some((p) => t.includes(p));
}

function restorePlaybackAudioMode() {
  return Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    shouldDuckAndroid: false,
  });
}

// 2026-08-10方案B第三版重写：前两版（react-native-webrtc读audioLevel）
// 暴露出两个根子问题，用户明确要求这次从架构上解决，不是再打补丁：
// ①react-native-webrtc的audioLevel在不同设备上量级完全不统一（真机1.0
// 量级、模拟器0.03量级，差了四五个数量级），说明这条路径本身不可靠；
// ②固定音量阈值分不清"人在说话"和"任何响动"（咳嗽/电视/别人说话），
// 而且WebRTC那路流一直占着麦克风，跟expo-av的Audio.Recording抢占硬件，
// 这是之前"录音启动失败"真实bug的根因，上一版靠"用之前先断开"绕开了，
// 治标不治本。
//
// 这版换成完全不用react-native-webrtc/react-native-incall-manager这条
// 依赖——环境监听和实际提问录音统统改用expo-av的Audio.Recording自带的
// metering（isMeteringEnabled+setOnRecordingStatusUpdate，字段范围是
// 标准的-160~0 dBFS，expo-av官方文档定义的固定量纲，不是某个库自己的
// 非标准实现，不会再出现"不同设备/不同库量级不统一"这类问题）。整个
// 免提功能自始至终只有expo-av这一个麦克风消费者，从设计上就不可能再有
// "两路同时抢麦克风"这类问题，不需要靠"用之前手动断开"这种时序技巧来
// 保证。副作用是也不再需要"require react-native-webrtc失败要try/catch"
// 这类兼容代码——expo-av是标准Expo SDK的一部分，Expo Go里也能跑。
const HF_METER_INTERVAL_MS = 120; // metering回调间隔，够快能及时发现说话开始/结束，又不会太密集耗电
// dBFS量纲下这个阈值需要真机校准（跟之前的1.0是完全不同的量纲，不能
// 类比），先给一个业内VAD教程常见的经验起点，真机验证后如果偏松/偏紧
// 再调整——这一步没有真机数据支撑，如实标注是估计值不是校准值。
const HF_SPEECH_DB = -35;
// 连续多久超过阈值才算"真的开始说话"（不是一声咳嗽），跟上一版
// VAD_SUSTAIN_POLLS×VAD_POLL_INTERVAL_MS(~600ms)是同一个用途，这版
// 调快到300ms——因为触发之后紧接着是"动态录到用户说完为止"，不再是
// 固定长窗口，稍微灵敏一点换来的是响应更快，代价（误触发）比以前小，
// 因为下面新加的"是不是真的在提问"这道语义过滤会兜住多数误触发。
const HF_SPEECH_SUSTAIN_MS = 300;
// 说话开始后，连续多久没检测到声音就认为"这句说完了"——不再是用户明确
// 反对的"固定6秒"，改成真的等用户说完。1.1秒是常见语音助手产品的经验
// 区间（太短容易在自然停顿处提前切断，太长等待感明显）。
const HF_SILENCE_END_MS = 1100;
// 触发之后这么久都没检测到真正超过阈值的声音，判定是这次触发本身就是
// 误判（比如一声响动够格触发但后面没人接着说话），直接放弃这一轮，不用
// 傻等到最大时长上限。
const HF_NO_SPEECH_TIMEOUT_MS = 4000;
// 安全上限：防止识别一直不停（比如背景持续有人在说话），录到这个时长
// 强制截止，不会无限录下去。
const HF_MAX_UTTERANCE_MS = 25000;

// 免提这条交互线始终完全独立于手动"打断"那套聊天气泡流程，不共用
// handleInterrupt/startAutoListen/conversation这些状态，也不跳出朗读
// 字幕这个视图。下面这套hf*函数和状态是专门为免提写的，跟方案A/手动
// 打断的代码除了都调用同一个transcribeAudio/streamAsk这些底层API之外，
// 没有其它共享状态。触发之后"听问题"和AI回答完之后"听追问/继续"用的
// 是同一套动态录音逻辑（hfRecordUntilSilence），不再像早期版本那样为
// 两个场景分别配一个固定时长——现在录音本身就是动态结束的，没必要再
// 区分"第一次给几秒、追问给几秒"。

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

// 设计稿里的"灯芯轨迹环"——呼吸缩放的发光球体+缓慢自转的轨迹环+外扩淡出
// 的三层脉冲光环，原设计用CSS animation做（breathe/spin/ping三个
// @keyframes），这里用RN内置的Animated复刻，不引入额外动画库。三层脉冲
// 环用不同的delay错开启动，效果是连续不断有环从中心扩散出去，不是三个
// 环同步跳动。
// 2026-08-10：免提这一轮进行中，字幕区不是唯一的状态提示——光晕本身也要
// 跟着换颜色/换节奏，用户确认过的预览稿（handsfree_flow_preview.html）
// 里这个球是"正在聆听"变亮加快脉动、"AI正在回答"变成翠色的关键视觉线索
// 之一，不只是装饰。stage不传或传''就是原来朗读中的默认样子，不影响
// 手动打断那条流程（那边根本不传这个prop）。
function ListenOrb({ stage }) {
  const breatheAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const breatheDuration = stage === 'listening' ? 550 : 1700; // "正在聆听"时脉动明显加快，跟预览稿的pulseFast节奏对齐
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(breatheAnim, { toValue: 1, duration: breatheDuration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(breatheAnim, { toValue: 0, duration: breatheDuration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    const spin = Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 14000, easing: Easing.linear, useNativeDriver: true }),
    );
    function ringLoop(anim, delay) {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 2600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
          Animated.delay(2600 * 2 - delay),
        ]),
      );
    }
    const r1 = ringLoop(ring1, 0);
    const r2 = ringLoop(ring2, 700);
    const r3 = ringLoop(ring3, 1400);
    breathe.start();
    spin.start();
    r1.start();
    r2.start();
    r3.start();
    return () => {
      breathe.stop();
      spin.stop();
      r1.stop();
      r2.stop();
      r3.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]); // stage变了要用新的breatheDuration重新起一次循环，不然还是旧节奏

  // "正在聆听"时脉动幅度也跟着放大（1→1.22，比默认的1.04明显得多），
  // 光是变快还不够醒目——这个数值跟预览稿pulseFast关键帧的1.22对齐。
  const orbScale = breatheAnim.interpolate({
    inputRange: [0, 1],
    outputRange: stage === 'listening' ? [1, 1.22] : [1, 1.04],
  });
  const orbitRotate = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  // 默认朗读中是ember橙；"AI正在回答"这一刻换成jade绿，跟字幕区回答文字
  // 的颜色对上，"聆听"阶段沿用ember但配合上面更快更大的脉动已经够醒目，
  // 不需要再单独换色，颜色变化太多反而分散注意力。
  const orbColor = stage === 'replying' ? EMBER.jade : EMBER.ember;

  function renderPingRing(anim) {
    const ringScale = anim.interpolate({ inputRange: [0, 1], outputRange: [92 / 220, 1] });
    const ringOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
    return <Animated.View style={[orbStyles.pingRing, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />;
  }

  return (
    <View style={orbStyles.zone}>
      {renderPingRing(ring1)}
      {renderPingRing(ring2)}
      {renderPingRing(ring3)}
      <Animated.View style={[orbStyles.orbit, { transform: [{ rotate: orbitRotate }] }]}>
        <View style={orbStyles.mote} />
      </Animated.View>
      <Animated.View style={[orbStyles.orb, { backgroundColor: orbColor, shadowColor: orbColor }, { transform: [{ scale: orbScale }] }]}>
        <IconDropletFilled color={EMBER.ink} size={30} />
      </Animated.View>
    </View>
  );
}

const orbStyles = StyleSheet.create({
  zone: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pingRing: {
    position: 'absolute', width: 220, height: 220, borderRadius: 110,
    borderWidth: 1, borderColor: EMBER.emberDim,
  },
  orbit: {
    position: 'absolute', width: 168, height: 168, borderRadius: 84,
    borderWidth: 0.5, borderColor: 'rgba(226,150,58,0.28)',
    alignItems: 'center',
  },
  mote: {
    position: 'absolute', top: -2.5, width: 5, height: 5, borderRadius: 2.5,
    backgroundColor: EMBER.emberBright,
  },
  orb: {
    width: 92, height: 92, borderRadius: 46,
    backgroundColor: EMBER.ember,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: EMBER.ember, shadowOpacity: 0.45, shadowRadius: 24, shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
});

export default function ListenScreen({ route, navigation }) {
  const { bookId, bookTitle, author, initialChapterTitle, startFraction } = route.params;
  const insets = useSafeAreaInsets();
  const { requireAuth } = useAuthGate();

  // phase: loading-book(打开界面首次拉章节列表) / loading-chapter(章节文字
  // 还没拉到) / playing / paused(打断后，对话线+输入框都在，等用户提问
  // 或点继续听书) / thinking(等AI回答) / answering(播AI回答语音，对话线
  // 上已经能看到文字答案) / done(全书听完) / error
  const [phase, setPhase] = useState('loading-book');
  const [errorMsg, setErrorMsg] = useState('');
  const [chapterTitle, setChapterTitle] = useState('');
  const [progressLabel, setProgressLabel] = useState('');
  // 接替1号任务1（视觉改造匹配设计稿）：设计稿要求朗读区域"字幕一次只
  // 显示一句，自动往下滚（实际由TTS播放进度驱动）"——之前只有笼统的
  // "正在朗读…"文案，这次改成显示当前实际在念的那一段文字本身，跟
  // progressLabel在同一处更新（真正开始出声那一刻，不是还在加载的时候，
  // 见onAudioStart回调的既有注释）。currentSegCount记"当前第几段/共几段"，
  // 拿来算进度条位置和"句 X/Y"这个计数，复用同一份数据不重复维护。
  const [currentCaption, setCurrentCaption] = useState('');
  const [currentSegCount, setCurrentSegCount] = useState({ idx: 0, total: 0 });
  // 播放/暂停按钮的"暂停"是纯音频暂停，不进对话视图（见handleInterrupt
  // 旁边togglePlayPause的注释）——每次真正有新的一段开始播放都要重置回
  // false，不然上一段暂停过的状态会误跟着下一段。
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);
  const [capturedText, setCapturedText] = useState('');
  const [question, setQuestion] = useState('');
  // 决策层这轮派发：连续追问改成对话式UI——这一轮打断期间的问答历史，
  // 既用来渲染屏幕上的对话线，也直接当streamAsk的history参数（跟消息
  // 数组同一份数据，不用conversationRef另外再维护一份，见上面refs区
  // 的说明）。
  const [conversation, setConversation] = useState([]);
  // 接替1号任务1：设计稿把语速/声音从齿轮菜单里的一整块面板，改成顶部
  // 两个独立的小标签，点哪个就单独弹出那一项的选择器——不再是"点设置图标
  // 打开一整块面板"这种交互，showSettings整个换掉，拆成三个独立开关。
  // "章节"标签设计稿说的是复用App已有的多层目录弹层，但那份嵌套结构
  // （章/节/小节）是解析EPUB文件本身才有的数据，只存在于ReaderScreen里，
  // 听书这边走的是`/app/books/{id}/context`这个接口，拿到的是数据库
  // `chapters`表的扁平列表（后端这轮改造后正好对应"章"这一级的宏观章节，
  // 粒度是合适的，只是没有更深的嵌套）——这里做成一个更简单的扁平章节
  // 选择弹层，不是照抄ReaderScreen那个支持多层嵌套的组件，是照顾实际
  // 数据可用性做的调整，不是没注意到设计稿这句话。
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [showRatePicker, setShowRatePicker] = useState(false);
  const [showChapterPicker, setShowChapterPicker] = useState(false);
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
  // 免提"一轮对话"独立状态机：''表示没有正在进行的免提轮次（这时候ambient
  // 的VAD监听按老逻辑跑），非空表示正在经历"暂停朗读→听问题→AI思考→
  // 念回答"这一整套流程，全程停留在朗读字幕这个视图里，不跳phase。
  // 命名前缀hf（hands-free），跟方案A的auto*/方案B旧的vad*/手动的
  // recordingRef等等这些完全不共用，就是要做到用户明确要求的"两条线互不
  // 干扰"。
  const [hfStage, setHfStage] = useState(''); // '' | 'listening' | 'thinking' | 'replying'
  const [hfText, setHfText] = useState(''); // 当前显示在字幕区的文字：用户问题(thinking起)或AI回答(replying)

  // playOneParagraph在playFrom的异步循环里调用，如果直接读voice/rate这两个
  // state会有闭包过期的问题（循环开始时闭包捕获的是当时的值，用户中途在
  // 设置面板改了声音，正在进行的循环感知不到）——用ref同步更新，效果是
  // "下一句开始播放就用新设置"，不用整个重启听书。
  const rateRef = useRef(rate);
  const voiceRef = useRef(voice);
  const chapterJumpingRef = useRef(false);
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

  // 免提"环境监听"这一路的expo-av录音——不产出任何要用的音频内容，只是
  // 借Audio.Recording的metering回调持续读音量，判断"有没有人开始说话"。
  // 触发之后会整个停掉（见startHandsFreeTurn），换一路全新的录音专门
  // 录这句话的内容，两路录音不会同时存在，从设计上排除了"两个消费者抢
  // 同一个麦克风"的可能，不需要再靠时序技巧保证。
  const hfAmbientRecordingRef = useRef(null);
  const hfAmbientSustainCountRef = useRef(0); // 连续超过阈值的metering回调次数
  const hfAmbientSpeakingRef = useRef(false); // 已经触发过一次、还没跌回安静，避免同一段话反复触发
  // 环境监听的metering回调是startHandsFreeAmbient调用那一刻创建的，之后
  // 每次判定"开始说话"都要调用"当前这次渲染"的startHandsFreeTurn（读到
  // 最新的phase/handsFreeMuted等状态）——跟方案A同样的闭包过期问题，同样
  // 的解法：用一个每次渲染都更新的ref间接调用，不直接把函数引用交给回调。
  const autoInterruptRef = useRef(null);

  // 免提独立状态机自己的一套ref，不复用recordingRef/autoListenRef等手动
  // 打断/方案A的引用——hfActiveRef是这一轮的"总开关"，任何一步异步操作
  // 回来发现它变成false都要立刻放弃（说明用户中途关了免提或离开了页面）。
  const hfActiveRef = useRef(false);
  const hfRecordingRef = useRef(null); // 正式录这一句话内容的录音（区别于上面的环境监听录音）
  const hfListenTimerRef = useRef(null); // 兜底的硬性超时，防止metering回调异常时无限录下去
  const hfListenResolveRef = useRef(null); // 让cancelHandsFreeTurn能立刻唤醒hfRecordUntilSilence里还在等待的Promise，不用干等到超时才发现被取消了
  const hfAbortRef = useRef(null);
  const hfReplyInterruptingRef = useRef(false);
  const hfTimingRef = useRef(null);

  function startHfTiming(reason) {
    const now = Date.now();
    hfTimingRef.current = { reason, startedAt: now, lastAt: now };
    console.log(`[免提计时] ${reason} start`);
  }

  function markHfTiming(label) {
    const now = Date.now();
    const timing = hfTimingRef.current;
    if (!timing) {
      console.log(`[免提计时] ${label}`);
      return;
    }
    console.log(`[免提计时] ${label}: +${now - timing.lastAt}ms / total ${now - timing.startedAt}ms`);
    timing.lastAt = now;
  }

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
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      sound.setOnPlaybackStatusUpdate((s) => {
        if (!s.isLoaded || s.didJustFinish) finish();
      });
      sound.playAsync().catch(() => finish()); // 播放本身失败也别卡住整个循环，跳过这段
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
            setCurrentCaption(paragraphs[pi]);
            setCurrentSegCount({ idx: pi, total: paragraphs.length });
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
    restorePlaybackAudioMode().catch(() => {});
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
      cancelHandsFreeTurn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  function handleInterrupt() {
    if (phase !== 'playing' && phase !== 'loading-chapter') return;
    // 续二十三访客模式：打断听书是为了问AI，属于三个约定触发点里的
    // "AI相关入口"——访客点这个按钮不进对话视图，先弹注册引导。朗读本身
    // （包括听书这个功能的入口）对访客照常开放，只挡这一步。
    if (!requireAuth('ai')) return;
    epochRef.current += 1;
    stopSound();
    // 免提总开关开着的话，环境监听那路expo-av录音一直在跑——用户改用手动
    // "打断"按钮进对话视图，接下来手动点麦克风（toggleRecording）也是
    // 开一路expo-av录音，两路会抢同一份麦克风，跟免提自己触发那条路径
    // 是同一类问题，这里对称处理：手动打断也要先放开环境监听的麦克风。
    if (handsFreeEnabled) stopHandsFreeAmbient();
    const { chapterIdx, paragraphIdx } = posRef.current;
    const chapter = chaptersRef.current[chapterIdx];
    const paragraphs = paragraphCacheRef.current[chapter?.id] || [];
    setCapturedText(paragraphs[paragraphIdx] || '');
    setQuestion('');
    setConversation([]); // 新一次打断，对话线清空重新开始
    setPhase('paused');
  }

  // 真机反馈：播放控制那排的播放/暂停按钮之前直接复用了handleInterrupt/
  // handleContinue，点一下暂停就整个进了打断提问的对话视图——用户明确
  // 要求这两个是两码事：暂停应该只是单纯停住/接着播这段音频，原地不动，
  // 不进提问模式；只有专门的"打断，我想问问"按钮才应该进对话视图。改成
  // 直接操作soundRef.current这个正在播放的Sound实例（pauseAsync/playAsync
  // 是expo-av对已加载音频的原生操作，不需要重新合成语音），不碰phase。
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

  // 接替1号任务2（可拖动进度条）：设计稿画的是"06:12/-10:24"这种真实播放
  // 时长的进度条，但目前听书这条播放链路（逐段现场调用edge-tts合成，见
  // playOneParagraph）没有提前知道整章/整本书总时长这件事——要做到design
  // 稿画的精确到秒，需要先给每段音频估算或者拿到真实时长再累加，这次没有
  // 做这层，是明确的简化：进度条按"当前第几段/共几段"（currentSegCount）
  // 算比例，不是真实播放时间，拖动结果是"跳到这一章的第N段重新播"，不是
  // "跳到第N秒"。如实说明这是简化非精确复刻design稿，不是没考虑过时间制。
  function handleSeekToFraction(fraction) {
    if (phase !== 'playing' && phase !== 'loading-chapter') return;
    const total = currentSegCount.total || 1;
    const targetPi = Math.min(Math.max(Math.round(fraction * (total - 1)), 0), total - 1);
    const { chapterIdx } = posRef.current;
    epochRef.current += 1;
    (async () => {
      await stopSound();
      playFrom(chapterIdx, targetPi, epochRef.current);
    })();
  }

  // 章节选择弹层点了某一章——从这一章开头重新播，跟"从0段开始"的老逻辑
  // 一致（chaptersRef是扁平的宏观章节列表，idx就是数组下标）。
  function handleJumpToChapter(idx) {
    if (idx < 0 || idx >= chaptersRef.current.length) return;
    if (chapterJumpingRef.current) return;
    chapterJumpingRef.current = true;
    epochRef.current += 1;
    (async () => {
      await stopSound();
      setShowChapterPicker(false);
      playFrom(idx, 0, epochRef.current);
      setTimeout(() => { chapterJumpingRef.current = false; }, 900);
    })();
  }

  // 环境监听时metering回调判定"开始说话"之后调用的入口——停掉环境监听那路
  // 录音（内容不要，只是刚才拿来测音量），马上开一路全新的录音正式捕捉
  // 这句话，全程留在朗读字幕视图（phase不变，不跳转），跟手动"打断"那套
  // 聊天气泡流程完全独立。
  function startHandsFreeTurn() {
    const interruptingReply = hfActiveRef.current && hfStage === 'replying';
    if (phase !== 'playing' && !interruptingReply) return;
    if (handsFreeMuted) return;
    if (hfActiveRef.current && !interruptingReply) return;
    if (interruptingReply) {
      hfReplyInterruptingRef.current = true;
    }
    hfActiveRef.current = true;
    epochRef.current += 1;
    startHfTiming(interruptingReply ? 'AI回复中二次打断' : '正文朗读中免提打断');
    (async () => {
      await stopSound();
      await stopHandsFreeAmbient(); // 等它真的放开麦克风，再开正式录音那一路，两路录音先后而不是同时存在
      markHfTiming('打断音频并释放环境监听');
      setHfStage('listening');
      setHfText('');
      await hfListenTurnLoop();
    })();
  }
  useEffect(() => { autoInterruptRef.current = startHandsFreeTurn; });

  // 动态端点检测录音：不再是固定时长——开始录之后持续读metering，一旦
  // 检测到真的有声音过、之后又连续安静够久（HF_SILENCE_END_MS），就认为
  // "这句说完了"，停止并送去识别；如果从头到尾都没检测到真正的声音（说明
  // 触发本身就是误判），HF_NO_SPEECH_TIMEOUT_MS之后直接放弃，不用户等到
  // 天长地久；HF_MAX_UTTERANCE_MS是防止一直有声音（比如背景持续有人在
  // 说话）导致录音停不下来的安全上限。全程没检测到过真正的声音的话，
  // 直接跳过transcribeAudio这次调用（没必要为了纯噪音/静音去请求一次
  // 语音识别）。
  async function hfRecordUntilSilence() {
    try {
      markHfTiming('准备正式录音');
      const { status: perm } = await Audio.getPermissionsAsync();
      if (perm !== 'granted') return null;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const recording = new Audio.Recording();
      let speechEverDetected = false;
      let silenceMs = 0;
      let elapsedMs = 0;
      let settled = false;
      const donePromise = new Promise((resolve) => {
        hfListenResolveRef.current = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
      });
      recording.setProgressUpdateInterval(HF_METER_INTERVAL_MS);
      recording.setOnRecordingStatusUpdate((status) => {
        if (!status.isRecording) return;
        elapsedMs += HF_METER_INTERVAL_MS;
        const db = typeof status.metering === 'number' ? status.metering : -160;
        if (db >= HF_SPEECH_DB) {
          speechEverDetected = true;
          silenceMs = 0;
        } else {
          silenceMs += HF_METER_INTERVAL_MS;
        }
        const shouldStop = (speechEverDetected && silenceMs >= HF_SILENCE_END_MS)
          || (!speechEverDetected && elapsedMs >= HF_NO_SPEECH_TIMEOUT_MS)
          || elapsedMs >= HF_MAX_UTTERANCE_MS;
        if (shouldStop) hfListenResolveRef.current?.();
      });
      await recording.prepareToRecordAsync({ ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true });
      await recording.startAsync();
      markHfTiming('正式录音已开始');
      hfRecordingRef.current = recording;
      // 双保险：万一某些机型metering回调不触发/触发不及时，硬性上限兜底，
      // 不会无限录下去。
      hfListenTimerRef.current = setTimeout(() => { hfListenResolveRef.current?.(); }, HF_MAX_UTTERANCE_MS + 1500);
      await donePromise;
      if (hfListenTimerRef.current) {
        clearTimeout(hfListenTimerRef.current);
        hfListenTimerRef.current = null;
      }
      hfListenResolveRef.current = null;
      if (!hfActiveRef.current) return null; // 等待期间被取消（关免提/离开页面），录音已经在cancelHandsFreeTurn里处理，这里直接放弃
      const rec = hfRecordingRef.current;
      hfRecordingRef.current = null;
      if (!rec) return null;
      await rec.stopAndUnloadAsync();
      markHfTiming(`端点检测结束 speech=${speechEverDetected} elapsed=${elapsedMs}ms`);
      const uri = rec.getURI();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      if (!speechEverDetected) return null; // 全程没有真的检测到声音，不浪费一次识别请求
      markHfTiming('开始ASR识别');
      const text = await transcribeAudio(uri, FileSystem.uploadAsync, FileSystem.FileSystemUploadType);
      markHfTiming(`ASR识别完成 chars=${(text || '').trim().length}`);
      return (text || '').trim();
    } catch (e) {
      markHfTiming(`录音/ASR失败 ${e.message || e}`);
      return null; // 静默失败——免提是锦上添花的功能，任何一步出错都直接放弃这一轮，不打断听书体验、不弹错误
    }
  }

  // 录一次+决定接下来怎么办：免提触发之后"听问题"、和AI回答完之后"听
  // 追问/继续"，都是同一套判断逻辑，抽出来共用，不用再为两个场景分别写
  // 一遍。识别到"继续"类指令或者压根没识别出内容——恢复朗读；识别出内容
  // 但AI判断这不是真的在向它提问（多半是环境噪音/电视声/别人说话被误
  // 识别）——用户明确要求"不相关就继续读"，同样恢复朗读，不弹出回答去
  // 打扰；只有真的是在提问，才进入askHandsFree真正去问AI。
  async function hfListenTurnLoop() {
    const text = await hfRecordUntilSilence();
    if (!hfActiveRef.current) return;
    markHfTiming(text ? `识别文本进入判断 chars=${text.length}` : '没有有效识别文本');
    if (!text || isContinueVoiceCommand(text)) {
      markHfTiming('判定为继续正文');
      finishHandsFreeTurn();
      return;
    }
    setHfText(text);
    setHfStage('thinking');
    const chapter = chaptersRef.current[posRef.current.chapterIdx];
    let relevant = true;
    try {
      markHfTiming('开始意图分类');
      relevant = await classifyIntent(text, bookTitle, chapter?.title || '');
      markHfTiming(`意图分类完成 relevant=${relevant}`);
    } catch (e) {
      markHfTiming(`意图分类失败 ${e.message || e}`);
      relevant = true; // 判断这一步本身失败，保守当成是提问，交给下面真正的问答逻辑处理
    }
    if (!hfActiveRef.current) return;
    if (!relevant && !looksLikeHandsFreeQuestion(text)) {
      markHfTiming('判定为无关内容，恢复正文');
      finishHandsFreeTurn();
      return;
    }
    await askHandsFree(text);
  }

  // 问AI+念回答；回答念完不是直接结束这一轮，而是跟方案A一样开一个追问/
  // 继续窗口（复用hfListenTurnLoop同一套判断）——用户明确要求"用户觉得
  // 没问题、说可以继续了，AI才继续讲"，这里用"安静或说继续类的词"当作
  // "没问题了"，识别到别的相关内容就当成追问、递归再问一轮，不会把用户
  // 晾在这里出不来。
  async function askHandsFree(question) {
    if (!hfActiveRef.current) return;
    hfReplyInterruptingRef.current = false;
    markHfTiming(`开始AI问答 questionChars=${question.length}`);
    const chapter = chaptersRef.current[posRef.current.chapterIdx];
    let replyWasInterrupted = false;
    await new Promise((resolve) => {
      hfAbortRef.current = streamAsk(
        {
          context: {
            bookTitle, author, chapterTitle: chapter?.title || '',
            selection: currentCaption, pageText: '',
            userHighlights: [], popularHighlights: [],
          },
          question,
          style: 'simple',
          history: [],
        },
        {
          onDelta: () => {},
          onDone: async (answer) => {
            hfAbortRef.current = null;
            markHfTiming(`AI回复完成 answerChars=${(answer || '').length}`);
            const fakeCfi = `listen:${chapter?.id}:${posRef.current.paragraphIdx}`;
            saveQaHistory({
              bookId, bookTitle, chapterTitle: chapter?.title || '',
              question, answer, selection: currentCaption, cfiRange: fakeCfi, style: 'simple',
            }).catch(() => {});
            if (!hfActiveRef.current) { resolve(); return; }
            setHfStage('replying');
            setHfText(answer);
            const epoch = epochRef.current;
            try {
              if (handsFreeEnabled && !handsFreeMuted) {
                setHandsFreeStatus('AI回复中也在监听');
                await startHandsFreeAmbient();
                markHfTiming('AI回复期间环境监听已开启');
              }
              await playOneParagraph(answer, epoch, () => markHfTiming('AI回复TTS开始播放'));
            } catch (e) {
              markHfTiming(`AI回复播放失败/中断 ${e.message || e}`);
              // 回答播放失败不阻塞后续流程，直接进入追问窗口
            }
            replyWasInterrupted = epoch !== epochRef.current || hfReplyInterruptingRef.current;
            if (!replyWasInterrupted) {
              await stopHandsFreeAmbient();
            }
            if (soundRef.current) {
              soundRef.current.unloadAsync().catch(() => {});
              soundRef.current = null;
            }
            if (replyWasInterrupted) {
              markHfTiming('AI回复已被二次打断，交给新一轮录音');
              resolve();
              return;
            }
            markHfTiming('AI回复播放结束');
            resolve();
          },
          onError: () => {
            hfAbortRef.current = null;
            markHfTiming('AI问答失败');
            resolve();
          },
        },
      );
    });
    if (!hfActiveRef.current) return;
    if (replyWasInterrupted) return;
    setHfStage('listening');
    setHfText('');
    await hfListenTurnLoop();
  }

  // 免提这一轮结束（不管是没听到问题、判断不相关、用户说继续、还是问答
  // 播完的追问窗口安静下来）——恢复朗读，并且如果免提总开关还开着、没被
  // 静音，重新开一路环境监听录音接回。
  function finishHandsFreeTurn() {
    hfActiveRef.current = false;
    hfReplyInterruptingRef.current = false;
    setHfStage('');
    setHfText('');
    const { chapterIdx, paragraphIdx } = posRef.current;
    epochRef.current += 1;
    markHfTiming(`恢复正文 chapter=${chapterIdx} paragraph=${paragraphIdx}`);
    playFrom(chapterIdx, paragraphIdx, epochRef.current);
    if (handsFreeEnabled && !handsFreeMuted) {
      setHandsFreeStatus('免提监听中');
      startHandsFreeAmbient();
    }
  }

  // 中途取消这一轮免提对话（用户关掉免提总开关、或者离开听书页）——跟
  // finishHandsFreeTurn的区别是不需要恢复朗读/重连环境监听，调用方
  // （handsFreeEnabled变化的effect、组件卸载清理）自己会处理后续。
  function cancelHandsFreeTurn() {
    if (!hfActiveRef.current) return;
    hfActiveRef.current = false;
    hfReplyInterruptingRef.current = false;
    if (hfListenTimerRef.current) {
      clearTimeout(hfListenTimerRef.current);
      hfListenTimerRef.current = null;
    }
    if (hfListenResolveRef.current) {
      hfListenResolveRef.current(); // 唤醒hfRecordUntilSilence里还在await的Promise，不然它要等到超时才会检查到hfActiveRef已经变false
      hfListenResolveRef.current = null;
    }
    hfAbortRef.current?.();
    hfAbortRef.current = null;
    const rec = hfRecordingRef.current;
    hfRecordingRef.current = null;
    if (rec) {
      rec.stopAndUnloadAsync().catch(() => {});
      Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
    }
    setHfStage('');
    setHfText('');
  }

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
    // 对应handleInterrupt里为了让出麦克风暂停的环境监听，回到朗读时如果
    // 免提总开关还开着（没被静音）就接回去——不加!hfAmbientRecordingRef.current
    // 这层判断的话，理论上不会有正在运行的环境监听（只有handleInterrupt
    // 会停它，进这里之前必然经过那一步），但多一层判断防止万一重复触发
    // 造成两路环境监听同时存在。
    if (handsFreeEnabled && !handsFreeMuted && !hfAmbientRecordingRef.current) {
      setHandsFreeStatus('免提监听中');
      startHandsFreeAmbient();
    }
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
      console.log(`[听书诊断] startAutoListen静默失败，真实原因：${e.message}`);
      // 静默失败，不设置recordingStatus——手动路径不受影响
    } finally {
      startingRecordingRef.current = false;
    }
  }

  // 环境监听：一路持续跑的expo-av录音，只借它的metering回调读音量，
  // 内容本身不要（说话真的被检测到时，这路录音会被整个停掉丢弃，见
  // startHandsFreeTurn）。连续HF_SPEECH_SUSTAIN_MS这么久都超过阈值才算
  // "真的开始说话"（防止瞬间噪音误触发），触发后要等音量先跌回阈值以下
  // 才会重新允许下一次触发。
  function handleAmbientMeterUpdate(status) {
    if (!status.isRecording || typeof status.metering !== 'number') return;
    if (status.metering >= HF_SPEECH_DB) {
      hfAmbientSustainCountRef.current += 1;
      if (!hfAmbientSpeakingRef.current
          && hfAmbientSustainCountRef.current * HF_METER_INTERVAL_MS >= HF_SPEECH_SUSTAIN_MS) {
        hfAmbientSpeakingRef.current = true;
        autoInterruptRef.current?.();
      }
    } else {
      hfAmbientSustainCountRef.current = 0;
      hfAmbientSpeakingRef.current = false;
    }
  }

  // 开启免提总开关——起一路expo-av录音专门用来测环境音量（内容不要）。
  // 不再依赖react-native-webrtc/react-native-incall-manager，expo-av是
  // 标准Expo SDK的一部分，不需要开发版本/dev client就能跑，Expo Go里
  // 也应该能用（跟手动打断那条录音路径用的是同一个底层能力）。
  async function startHandsFreeAmbient() {
    try {
      const { status: perm } = await Audio.requestPermissionsAsync();
      if (perm !== 'granted') {
        setHandsFreeStatus('麦克风权限被拒绝，免提打断无法开启');
        setHandsFreeEnabled(false);
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const recording = new Audio.Recording();
      hfAmbientSustainCountRef.current = 0;
      hfAmbientSpeakingRef.current = false;
      recording.setProgressUpdateInterval(HF_METER_INTERVAL_MS);
      recording.setOnRecordingStatusUpdate(handleAmbientMeterUpdate);
      await recording.prepareToRecordAsync({ ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true });
      await recording.startAsync();
      hfAmbientRecordingRef.current = recording;
      setHandsFreeStatus('免提监听中');
    } catch (e) {
      setHandsFreeStatus(`免提打断启动失败：${e.message}`);
      setHandsFreeEnabled(false);
    }
  }

  async function stopHandsFreeAmbient() {
    const rec = hfAmbientRecordingRef.current;
    hfAmbientRecordingRef.current = null;
    if (rec) {
      await rec.stopAndUnloadAsync().catch(() => {});
    }
    // iOS上allowsRecordingIOS=true时系统可能把音频路由切到更适合录音的
    // 模式，用户真机反馈"取消监听后朗读音量明显变小"。停止环境监听后
    // 立刻恢复播放模式，避免继续留在录音路由里。
    await restorePlaybackAudioMode().catch(() => {});
    setHandsFreeStatus('');
  }

  // 免提开关变化时连接/断开——开关本身之外，退出这个屏幕（组件卸载）也
  // 要确保断开，不能让这路环境监听录音在离开听书页之后还占着麦克风。
  useEffect(() => {
    if (handsFreeEnabled) {
      setHandsFreeStatus('连接中…');
      startHandsFreeAmbient();
    }
    // 所有收尾逻辑都放进cleanup，不要在效果体的else分支里重复一遍——React
    // 在依赖变化时会先跑上一次effect的cleanup，再跑这一次的效果体，如果
    // "取消+判断要不要续播"分别写在cleanup和else分支两处，等else分支执行
    // 的时候cleanup早就已经把hfActiveRef清成false了，读到的永远是false，
    // 续播判断形同虚设（这是真机之外，纯代码审查就能发现的一处逻辑错误，
    // 写完之后自己复查发现的，不是真机反馈）。
    return () => {
      const wasActive = hfActiveRef.current;
      cancelHandsFreeTurn();
      stopHandsFreeAmbient();
      // 关掉总开关时如果正好卡在免提的听/答某一步，朗读已经因为这一轮被
      // 停掉了，取消之后要自己接手续上，不然屏幕会停在"看起来正常、但
      // 其实没在播"的状态。真正离开页面（组件卸载）这一刻理论上也会走
      // 到这里，届时playFrom内部的epoch校验和React 18对已卸载组件
      // setState的静默忽略保证了不会有实际副作用/报错，不需要额外区分
      // "是不是真的在卸载"专门处理。
      if (wasActive) {
        const { chapterIdx, paragraphIdx } = posRef.current;
        epochRef.current += 1;
        playFrom(chapterIdx, paragraphIdx, epochRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFreeEnabled]);

  const inConversation = phase === 'paused' || phase === 'thinking' || phase === 'answering';
  const inNarrating = phase === 'playing' || phase === 'loading-chapter';
  const segFraction = currentSegCount.total > 1 ? currentSegCount.idx / (currentSegCount.total - 1) : 0;

  return (
    <View style={styles.stage}>
      <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.safe}>
        <View style={[styles.bar, { paddingTop: insets.top + 14 }]}>
          <TouchableOpacity onPress={handleStopListening} style={styles.iconBtn}>
            <IconChevronLeft color={EMBER.paperDim} size={20} strokeWidth={2} />
          </TouchableOpacity>
          <View style={styles.crumb}>
            <Text style={styles.bookTitleText} numberOfLines={1}>{bookTitle}</Text>
            <Text style={styles.chapCrumbText} numberOfLines={1}>{chapterTitle}</Text>
          </View>
          <View style={{ width: 30 }} />
        </View>

        {(inNarrating || inConversation) && (
          <View style={styles.quickSettings}>
            <TouchableOpacity style={styles.settingChip} onPress={() => setShowChapterPicker(true)}>
              <IconList color={EMBER.paperDim} size={12} strokeWidth={2} />
              <Text style={styles.settingChipText} numberOfLines={1}>{chapterTitle || '章节'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.settingChip} onPress={() => setShowVoicePicker(true)}>
              <IconVolume color={EMBER.paperDim} size={12} strokeWidth={2} />
              <Text style={styles.settingChipText}>{VOICE_OPTIONS.find((o) => o.value === voice)?.label.replace(/（.*）/, '') || '声音'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.settingChip} onPress={() => setShowRatePicker(true)}>
              <IconBolt color={EMBER.paperDim} size={12} strokeWidth={2} />
              <Text style={styles.settingChipText}>{rateStrToMultiplier(rate).toFixed(2)}×</Text>
            </TouchableOpacity>
          </View>
        )}

        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {phase === 'loading-book' && (
            <View style={styles.centerBox}><ActivityIndicator color={EMBER.emberBright} /></View>
          )}

          {phase === 'error' && (
            <View style={styles.centerBox}>
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          )}

          {phase === 'done' && (
            <View style={styles.centerBox}>
              <Text style={styles.doneText}>这本书听完了</Text>
              <TouchableOpacity style={styles.resumeBtn} onPress={handleStopListening}>
                <Text style={styles.resumeBtnText}>返回</Text>
              </TouchableOpacity>
            </View>
          )}

          {(inNarrating || inConversation) && (
            <>
              <View style={styles.mainStage}>
                {inNarrating ? (
                  <>
                    <ListenOrb stage={hfStage} />
                    <View style={styles.captionZone}>
                      {phase === 'loading-chapter' ? (
                        <ActivityIndicator color={EMBER.emberBright} />
                      ) : hfStage ? (
                        // 免提这一轮进行中——字幕区不显示原来在念的正文，改成
                        // 免提自己的状态展示，全程留在这个视图里，不跳转页面。
                        // 用户在确认稿（handsfree_flow_preview.html）里明确
                        // 认可的是"识别出的问题用橙色字、AI的回答用绿色字"这
                        // 个颜色区分，不是两段文字用同一个颜色摆在一起——
                        // 这是"感觉像对话"这句反馈里真正落地的那部分，照抄。
                        <>
                          <Text style={styles.hfStageLabel}>
                            {hfStage === 'listening' ? '正在聆听…' : hfStage === 'thinking' ? 'AI正在思考…' : 'AI正在回答'}
                          </Text>
                          {hfStage !== 'listening' && !!hfText && (
                            <Text style={hfStage === 'replying' ? styles.hfAiText : styles.hfUserText}>{hfText}</Text>
                          )}
                          {hfStage === 'thinking' && (
                            <ActivityIndicator color={EMBER.emberBright} style={styles.hfThinkingSpin} />
                          )}
                        </>
                      ) : (
                        <>
                          <Text style={styles.captionTextEl}>{currentCaption}</Text>
                          {currentSegCount.total > 0 && (
                            <Text style={styles.captionCountText}>句 {currentSegCount.idx + 1}/{currentSegCount.total}</Text>
                          )}
                        </>
                      )}
                    </View>
                  </>
                ) : (
                  <ScrollView contentContainerStyle={styles.chatBody}>
                    <View style={styles.contextChip}>
                      <Text style={styles.contextChipLbl}>你打断时正讲到</Text>
                      <Text style={styles.contextChipText}>{capturedText}</Text>
                    </View>

                    {conversation.map((msg, idx) => (
                      <View
                        key={idx}
                        style={[styles.bubble, msg.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}
                      >
                        <Text style={msg.role === 'user' ? styles.bubbleUserText : styles.bubbleAiText}>
                          {msg.content}
                        </Text>
                      </View>
                    ))}

                    {phase === 'thinking' && (
                      <View style={styles.thinkingRow}>
                        <ActivityIndicator color={EMBER.emberBright} size="small" />
                        <Text style={styles.thinkingText}>AI正在思考…</Text>
                      </View>
                    )}
                    {phase === 'answering' && (
                      <View style={styles.thinkingRow}>
                        <ActivityIndicator color={EMBER.emberBright} size="small" />
                        <Text style={styles.thinkingText}>AI正在朗读回答…</Text>
                      </View>
                    )}

                    {phase === 'paused' && (
                      <View style={styles.resumeRow}>
                        <TouchableOpacity style={styles.resumeRowBtn} onPress={handleContinue}>
                          <Text style={styles.resumeRowBtnText}>继续听下去</Text>
                        </TouchableOpacity>
                        <Text style={styles.continueHint}>或者接着追问</Text>
                      </View>
                    )}
                  </ScrollView>
                )}
              </View>

              {/* 设计稿："其余部分（进度条、播放控制）原地不动"——不管是朗读中
                  还是打断对话中，controls这部分都渲染在同一个位置，只有上面
                  main-stage的内容跟着phase切换。 */}
              <View style={styles.controls}>
                <View style={styles.progress}>
                  <Slider
                    style={styles.progressSlider}
                    minimumValue={0}
                    maximumValue={1}
                    value={segFraction}
                    disabled={phase === 'loading-chapter' || currentSegCount.total <= 1}
                    minimumTrackTintColor={EMBER.ember}
                    maximumTrackTintColor="rgba(255,255,255,0.1)"
                    thumbTintColor={EMBER.emberBright}
                    onSlidingComplete={handleSeekToFraction}
                  />
                  <View style={styles.progressTimes}>
                    <Text style={styles.progressTimeText}>{progressLabel || '—'}</Text>
                    <Text style={styles.progressTimeText}>{chapterTitle}</Text>
                  </View>
                </View>

                <View style={styles.transport}>
                  <TouchableOpacity
                    style={styles.transportIconBtn}
                    onPress={() => handleJumpToChapter(posRef.current.chapterIdx - 1)}
                  >
                    <IconPlayerTrackPrevFilled color={EMBER.paperDim} size={20} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.transportPlayBtn}
                    onPress={togglePlayPause}
                    disabled={phase !== 'playing'}
                  >
                    {isManuallyPaused
                      ? <IconPlayerPlayFilled color={EMBER.emberBright} size={22} />
                      : <IconPlayerPauseFilled color={EMBER.emberBright} size={22} />}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.transportIconBtn}
                    onPress={() => handleJumpToChapter(posRef.current.chapterIdx + 1)}
                  >
                    <IconPlayerTrackNextFilled color={EMBER.paperDim} size={20} />
                  </TouchableOpacity>
                </View>

                {inNarrating ? (
                  <View style={styles.askZone}>
                    {!handsFreeEnabled ? (
                      <TouchableOpacity style={styles.interruptBtnEl} onPress={handleInterrupt}>
                        <Text style={styles.interruptBtnElText}>打断，我想问问</Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={styles.hfLive}>
                        <Text style={styles.listeningTag}>
                          {hfStage
                            ? (hfStage === 'listening' ? '正在聆听你的问题' : hfStage === 'thinking' ? 'AI正在思考…' : 'AI正在回答')
                            : (handsFreeMuted ? '已静音 · 朗读继续' : '正在聆听 · 随时开口')}
                        </Text>
                        <TouchableOpacity
                          style={styles.muteIconBtn}
                          onPress={() => setHandsFreeMuted((v) => !v)}
                        >
                          <IconMicrophoneOff color={handsFreeMuted ? EMBER.emberBright : EMBER.paperDim} size={13} strokeWidth={2} />
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ) : (
                  <>
                    {phase === 'paused' && (
                      <View style={styles.saveHighlightRow}>
                        <Switch value={saveAsHighlight} onValueChange={setSaveAsHighlight} />
                        <Text style={styles.saveHighlightText}>把刚才这段保存为划线</Text>
                      </View>
                    )}
                    {phase === 'paused' && (
                      <View style={styles.inputBarEl}>
                        <TouchableOpacity
                          style={[styles.micBtnEl, isRecording && styles.micBtnElOn]}
                          onPress={toggleRecording}
                        >
                          <IconMicrophone color={isRecording ? EMBER.emberBright : EMBER.paperDim} size={15} strokeWidth={2} />
                        </TouchableOpacity>
                        {isTranscribing ? (
                          <View style={[styles.inputFieldEl, styles.transcribingBox]}>
                            <ActivityIndicator size="small" color={EMBER.emberBright} />
                            <Text style={styles.transcribingText}>正在识别语音…</Text>
                          </View>
                        ) : (
                          <TextInput
                            style={styles.inputFieldEl}
                            placeholder={conversation.length ? '再问一句…' : '想问点什么？'}
                            placeholderTextColor={EMBER.inkSoft}
                            value={question}
                            onChangeText={setQuestion}
                          />
                        )}
                        <TouchableOpacity
                          style={[styles.sendBtnEl, !question.trim() && styles.sendBtnElDisabled]}
                          onPress={handleAsk}
                          disabled={!question.trim()}
                        >
                          <IconSend color={EMBER.ink} size={15} strokeWidth={2} />
                        </TouchableOpacity>
                      </View>
                    )}
                    {!!recordingStatus && !isTranscribing && phase === 'paused' && (
                      <Text style={styles.recordingStatusText}>{recordingStatus}</Text>
                    )}
                  </>
                )}

                {inNarrating && (
                  <>
                    <TouchableOpacity
                      style={[styles.micToggle, handsFreeEnabled && styles.micToggleOn]}
                      onPress={() => {
                        // 续二十三访客模式：免提是"AI相关入口"，只挡"开启"这个
                        // 方向——关掉免提（已经开着的情况下）不需要账号，任何
                        // 时候都该能关，只是访客理论上没法先把它打开。
                        if (!handsFreeEnabled && !requireAuth('ai')) return;
                        setHandsFreeEnabled((v) => !v);
                      }}
                      accessibilityLabel="开始提问"
                    >
                      {handsFreeEnabled
                        ? <IconMicrophone color={EMBER.emberBright} size={18} strokeWidth={2} />
                        : <IconMicrophoneOff color={EMBER.inkSoft} size={18} strokeWidth={2} />}
                    </TouchableOpacity>
                    {/* handsFreeStatus独立于handsFreeEnabled展示——启动失败时
                        startHandsFreeAmbient会把handsFreeEnabled设回false，如果
                        这里的文案也跟着handsFreeEnabled切换，失败原因会在
                        用户还没看清楚之前就被"点击开始提问"这句默认文案盖掉，
                        看不出到底出了什么问题。 */}
                    <Text style={styles.micLabelText}>
                      {handsFreeStatus || (handsFreeEnabled ? '免提已开启，随时说话' : '点击开始提问')}
                    </Text>
                  </>
                )}
              </View>
            </>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* 声音/语速/章节 三个弹层，点对应的chip各自单独打开——设计稿要求
          "点哪个标签就能直接改"，不是打开一整块设置面板。 */}
      <Modal visible={showVoicePicker} transparent animationType="fade" onRequestClose={() => setShowVoicePicker(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowVoicePicker(false)}>
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>选择声音</Text>
            {VOICE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={[styles.pickerRow, voice === opt.value && styles.pickerRowActive]}
                onPress={() => { setVoice(opt.value); setShowVoicePicker(false); }}
              >
                <Text style={[styles.pickerRowText, voice === opt.value && styles.pickerRowTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showRatePicker} transparent animationType="fade" onRequestClose={() => setShowRatePicker(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowRatePicker(false)}>
          <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>语速 {rateDisplay.toFixed(2)}×</Text>
            <Slider
              style={styles.pickerSlider}
              minimumValue={RATE_MIN}
              maximumValue={RATE_MAX}
              step={RATE_STEP}
              value={rateStrToMultiplier(rate)}
              minimumTrackTintColor={EMBER.ember}
              maximumTrackTintColor="rgba(255,255,255,0.15)"
              thumbTintColor={EMBER.emberBright}
              onValueChange={setRateDisplay}
              onSlidingComplete={(v) => setRate(rateMultiplierToStr(v))}
            />
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showChapterPicker} transparent animationType="fade" onRequestClose={() => setShowChapterPicker(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowChapterPicker(false)}>
          <View style={[styles.pickerCard, styles.pickerCardTall]} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>目录</Text>
            <ScrollView>
              {chaptersRef.current.map((c, idx) => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.pickerRow, chapterTitle === c.title && styles.pickerRowActive]}
                  onPress={() => handleJumpToChapter(idx)}
                >
                  <Text style={[styles.pickerRowText, chapterTitle === c.title && styles.pickerRowTextActive]} numberOfLines={1}>
                    {c.title}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: EMBER.ink },
  safe: { flex: 1 },
  flex: { flex: 1 },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingBottom: 4,
  },
  iconBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  crumb: { flex: 1, alignItems: 'center' },
  bookTitleText: { fontSize: 15, color: EMBER.paper, fontWeight: '600' },
  chapCrumbText: { fontSize: 10.5, color: EMBER.inkSoft, marginTop: 3, letterSpacing: 0.3 },

  quickSettings: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  settingChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 0.5, borderColor: EMBER.inkSoft, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)', paddingHorizontal: 12, paddingVertical: 6,
    maxWidth: 120,
  },
  settingChipText: { fontSize: 11, color: EMBER.paperDim },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorText: { fontSize: 14, textAlign: 'center', color: EMBER.paperDim },
  doneText: { fontSize: 17, color: EMBER.paper, fontWeight: '600' },

  mainStage: { flex: 1 },
  captionZone: {
    paddingHorizontal: 30, paddingBottom: 8, minHeight: 90,
    alignItems: 'center', justifyContent: 'flex-start',
  },
  captionTextEl: { fontSize: 17, lineHeight: 27, textAlign: 'center', color: EMBER.paper },
  captionCountText: { fontSize: 10.5, color: EMBER.inkSoft, marginTop: 8, letterSpacing: 0.5 },
  hfStageLabel: { fontSize: 12.5, color: EMBER.emberBright, letterSpacing: 0.3, marginBottom: 10 },
  hfThinkingSpin: { marginTop: 12 },
  hfUserText: { fontSize: 17, lineHeight: 27, textAlign: 'center', color: EMBER.emberBright, fontWeight: '600' },
  hfAiText: { fontSize: 17, lineHeight: 27, textAlign: 'center', color: EMBER.jade },

  chatBody: { flexGrow: 1, padding: 16, gap: 14 },
  contextChip: {
    backgroundColor: 'rgba(226,150,58,0.08)', borderLeftWidth: 2, borderLeftColor: EMBER.emberDim,
    borderRadius: 4, padding: 10,
  },
  contextChipLbl: { fontSize: 10, color: EMBER.ember, marginBottom: 4, textTransform: 'uppercase' },
  contextChipText: { fontSize: 12.5, lineHeight: 19, color: EMBER.paperDim },
  bubble: { padding: 12, borderRadius: 16, maxWidth: '82%' },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: EMBER.emberDim, borderBottomRightRadius: 4 },
  bubbleAi: {
    alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.08)', borderBottomLeftRadius: 4,
  },
  bubbleUserText: { fontSize: 13.5, lineHeight: 20, color: EMBER.paper },
  bubbleAiText: { fontSize: 13.5, lineHeight: 20, color: EMBER.paper },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  thinkingText: { fontSize: 13, color: EMBER.paperDim },
  resumeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  resumeRowBtn: {
    backgroundColor: 'rgba(111,160,136,0.12)', borderWidth: 0.5, borderColor: 'rgba(111,160,136,0.4)',
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
  },
  resumeRowBtnText: { fontSize: 12.5, color: EMBER.jade, fontWeight: '600' },
  continueHint: { fontSize: 12, color: EMBER.inkSoft },
  resumeBtn: {
    backgroundColor: EMBER.ember, borderRadius: 999, paddingHorizontal: 26, paddingVertical: 12,
  },
  resumeBtnText: { fontSize: 14, color: EMBER.ink, fontWeight: '700' },

  controls: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 22, gap: 14 },
  progress: { gap: 5 },
  progressSlider: { width: '100%', height: 28 },
  progressTimes: { flexDirection: 'row', justifyContent: 'space-between' },
  progressTimeText: { fontSize: 10.5, color: EMBER.inkSoft, letterSpacing: 0.3, maxWidth: '55%' },

  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28 },
  transportIconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  transportPlayBtn: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(226,150,58,0.14)', borderWidth: 1, borderColor: 'rgba(226,150,58,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },

  askZone: { minHeight: 34, alignItems: 'center', justifyContent: 'center' },
  interruptBtnEl: {
    backgroundColor: EMBER.ember, borderRadius: 999, paddingHorizontal: 30, paddingVertical: 12,
  },
  interruptBtnElText: { fontSize: 14, color: EMBER.ink, fontWeight: '600' },
  hfLive: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  listeningTag: { fontSize: 11.5, color: EMBER.emberBright, letterSpacing: 0.3 },
  muteIconBtn: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },

  saveHighlightRow: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  saveHighlightText: { fontSize: 12.5, color: EMBER.paperDim },
  inputBarEl: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  micBtnEl: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  micBtnElOn: { backgroundColor: 'rgba(226,150,58,0.18)' },
  inputFieldEl: {
    flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 9, fontSize: 13, color: EMBER.paper,
  },
  transcribingBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  transcribingText: { fontSize: 12.5, color: EMBER.paperDim },
  sendBtnEl: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: EMBER.ember,
  },
  sendBtnElDisabled: { opacity: 0.4 },
  recordingStatusText: { fontSize: 11.5, color: EMBER.inkSoft, textAlign: 'center' },

  micToggle: {
    alignSelf: 'center', width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: EMBER.inkSoft,
  },
  micToggleOn: { backgroundColor: 'rgba(226,150,58,0.14)', borderColor: EMBER.ember },
  micLabelText: { fontSize: 10, color: EMBER.inkSoft, textAlign: 'center', letterSpacing: 0.3 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  pickerCard: {
    width: '100%', maxWidth: 340, backgroundColor: EMBER.dusk,
    borderRadius: 16, borderWidth: 0.5, borderColor: 'rgba(226,150,58,0.25)', padding: 16,
  },
  pickerCardTall: { maxHeight: '70%' },
  pickerTitle: { fontSize: 15, color: EMBER.paper, fontWeight: '600', marginBottom: 10 },
  pickerRow: { paddingVertical: 12, paddingHorizontal: 8, borderRadius: 10 },
  pickerRowActive: { backgroundColor: 'rgba(226,150,58,0.14)' },
  pickerRowText: { fontSize: 14, color: EMBER.paperDim },
  pickerRowTextActive: { color: EMBER.emberBright, fontWeight: '600' },
  pickerSlider: { width: '100%', height: 36, marginTop: 8 },
});
