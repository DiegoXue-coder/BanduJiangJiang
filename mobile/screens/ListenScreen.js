// 阶段十七：听书核心体验v1（按钮打断版）——独立于ReaderScreen里"问AI"的
// 聊天面板，这里是"持续朗读书本正文，随时能打断问问题，问完接着往下听"
// 这条单独的交互线。跟BookChatScreen的TTS播放队列（预取下一句、拼短句）
// 不是同一套代码——那套是给"AI流式吐字、边生成边念"设计的，这里书本内容
// 是提前一次性知道的（不是流式生成的），用不着那套预取重叠优化，改成
// 简单的"一段一段顺序加载播放"，代码简单很多，也不会带上那套至今还没
// 排查清楚的乱序/丢句问题（阶段十七开工前置条件那次真机没能复现，日志
// 还留着，详见04-开发进度记录.md）。
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, ScrollView, FlatList, Platform, KeyboardAvoidingView, Switch,
  Modal, Animated, AppState, Linking,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import Slider from '@react-native-community/slider';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import {
  IconChevronLeft, IconList, IconVolume, IconBolt,
  IconPlayerTrackPrevFilled, IconPlayerTrackNextFilled,
  IconPlayerPlayFilled, IconPlayerPauseFilled,
  IconMicrophone, IconSend, IconVolumeOff,
} from '@tabler/icons-react-native';
import {
  getBookContext, getChapterText, getStandardChapterText, getTtsPlayUrl, getTtsWithTiming, transcribeAudio,
  streamAsk, saveHighlight, saveQaHistory, classifyIntent, submitVoiceLatencyMetric,
  getListenProgress, saveListenProgress, getListenHistory,
} from '../lib/api';
import { useAuthGate } from '../lib/authGate';
import { FONTS } from '../fonts';
const {
  appendPromptTurn,
  historyRowsToMessages,
  normalizeListenSettings,
  resolveListenChapter,
  resolveListenParagraph,
} = require('../lib/listenContinuity');
const {
  captionVisualStateForSentence,
  playbackRecoveryAction,
  preparedSoundMatches,
  resolveNarrationStep,
  resolveJumpTarget,
  stripCitationMarkersForSpeech,
  expectsExternalSearch,
} = require('../lib/listenPlayback');

// 听书页使用最终原型 listen-final-prototype 的中性炭黑暗色，不再沿用旧版
// 暖棕背景。棕色只作为细节强调色，避免整屏偏棕。
const EMBER = {
  ink: '#101113',
  dusk: '#1a1c1f',
  dusk2: '#222428',
  paper: '#efede8',
  paperDim: '#9c9da0',
  inkSoft: '#676a70',
  ember: '#b17c43',
  emberBright: '#b17c43',
  emberDim: '#6f4e2d',
  jade: '#6fa088',
  jadeDim: '#3d5b4c',
  screenBg1: '#1a1c1f',
  screenBg2: '#141517',
  screenBg3: '#101113',
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
const CONTINUE_READING_VOICE_PATTERNS = [
  '继续读', '继续念', '继续听', '继续讲述', '继续讲书', '继续正文', '继续原文',
  '接着读', '接着念', '接着听', '接着讲述', '接着讲书',
  '往下读', '往下念', '读下去', '念下去', '讲下去', '说下去',
];
// 听书页的默认语境是回到正文讲述，所以"继续讲/继续说/接着讲"这种
// 模糊说法不拦截为追问；只有明确要求AI继续解释/讲解时才留在问答线。
const FOLLOW_UP_VOICE_PATTERNS = [
  '继续解释', '继续讲解', '接着解释', '接着讲解',
  '再解释', '再讲讲', '展开讲', '详细讲',
];
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
    playThroughEarpieceAndroid: false,
  });
}

function enableRecordingAudioMode() {
  return Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
    shouldDuckAndroid: false,
    playThroughEarpieceAndroid: false,
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
const HF_SPEECH_DB = -30;
const HF_SPEECH_NOISE_MARGIN_DB = 12;
const HF_SPEECH_MIN_PEAK_DB = -26;
// 连续多久超过阈值才算"真的开始说话"（不是一声咳嗽），跟上一版
// VAD_SUSTAIN_POLLS×VAD_POLL_INTERVAL_MS(~600ms)是同一个用途，这版
// 调快到300ms——因为触发之后紧接着是"动态录到用户说完为止"，不再是
// 固定长窗口，稍微灵敏一点换来的是响应更快，代价（误触发）比以前小，
// 因为下面新加的"是不是真的在提问"这道语义过滤会兜住多数误触发。
const HF_SPEECH_SUSTAIN_MS = 720;
const HF_TRIGGER_COOLDOWN_MS = 1800;
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
// 手动长按说话时，用户的手指才是主要端点信号：按住就持续收音，松手才
// 送去识别。VAD 在这条路径只做日志/诊断，不再因为 1 秒左右的自然停顿
// 替用户结束问题；仍保留硬上限，避免误触后无限录音。
const HF_MANUAL_HOLD_MAX_MS = MAX_RECORDING_MS;
const HF_MANUAL_HOLD_MIN_MS = 350;
// 2026-09-05真机复测后统一成"手动按住说话"：iOS最初是为了解决常驻录音
// 压低外放音量，Android虽然技术上能常驻监听，但用户反馈环境噪音容易误
// 触发，而且两端交互不一致。测试阶段先把两端都收敛成可控模式：听书时不
// 常驻开麦，用户按住麦克风录音、松手发送问题。
const MANUAL_HOLD_TO_TALK = true;

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
const RESUME_CHAR_BACKTRACK = 12; // 段内恢复时回退少量字，避免从半个词中间接上
// 任务卡09/11第一阶段：用户手指离开屏幕、惯性滚动也停下来之后，停顿这么久
// 还没有新动作，就自动弹回正在朗读的那句、恢复自动跟随。4秒是用户口述的
// 起始估计值，先按这个实现，真机试过手感觉得太快/太慢再调。
const CAPTION_IDLE_SNAPBACK_MS = 4000;
const CAPTION_CANDIDATE_DWELL_MS = 500;
// 手指抬起(onScrollEndDrag)后，等这么久看有没有紧接着的惯性滚动
// (onMomentumScrollBegin)——安卓/iOS都存在"松手时已经没有速度，不会触发
// 惯性滚动事件"的情况，纯靠onScrollEndDrag会导致这类场景永远等不到
// 惯性结束事件、弹回计时器永远不会启动。这个等待窗口只是用来分辨
// "松手即静止"和"松手后还在惯性滑"两种情况，不是弹回倒计时本身。
const CAPTION_MOMENTUM_WAIT_MS = 80;
const CAPTION_MOMENTUM_SAFETY_MS = 450;
const CAPTION_STALL_REALIGN_MS = 600;
const ANDROID_CAPTION_FOLLOW_WATCHDOG_MS = 600;
const LISTEN_PROGRESS_SAVE_INTERVAL_MS = 3000;
const LISTEN_HISTORY_TURNS = 4;
const NARRATION_STATUS_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getResumeSlice(text, charOffset) {
  const offset = Math.max(0, Math.min(text.length - 1, charOffset || 0));
  const startOffset = Math.max(0, offset - RESUME_CHAR_BACKTRACK);
  return {
    text: text.slice(startOffset).trimStart() || text,
    startOffset,
  };
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
// 第一段只等到一个不太短的完整句子就开始合成；后续句子由现有队列预取。
// 16 字是在“尽快开口”和“避免一句太短导致听感碎裂”之间的保守折中。
const HF_REPLY_MIN_TTS_CHUNK_LEN = 16;
const HF_REPLY_TTS_STREAMING_ENABLED = true;

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

// 真机反馈：用户在打断提问/免提提问时，AI经常回答"手头没有这段内容"，
// 但用户明明已经听到了——旧逻辑只把"当前正在播的这一段"塞进context，
// 用户往后跳过播放位置、或者问的是刚听完的上一段时，那段文字早就不在
// "当前段"里了。改成把本章已经播放过的所有段落（含当前段）拼起来当
// selection，AI手头就有听众实际听过的全部内容。经典公版文本单章通常
// 不长，直接拼全量；只在极端长章节时从末尾截断，保证"刚听完的内容"
// 优先保留，不会被章节开头的内容挤掉。
const HEARD_CONTEXT_MAX_CHARS = 6000;
function buildHeardChapterContext(paragraphs, paragraphIdx) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return '';
  // 段落之间用空行分隔，后端_bounded_context_text按空行切段落、超长时保留
  // 尾部——不加分隔符的话一整章会被后端当成一个大段落，尾部截断就退化成
  // 只在一句话中间硬切，不如按段落边界收敛准。
  const heard = paragraphs.slice(0, Math.max(0, paragraphIdx) + 1).join('\n\n');
  return heard.length > HEARD_CONTEXT_MAX_CHARS ? heard.slice(-HEARD_CONTEXT_MAX_CHARS) : heard;
}

function splitCaptionSentences(text) {
  if (!text) return [];
  const ranges = [];
  const re = /[^。！？；\n]+[。！？；\n]?/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    ranges.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return ranges.length ? ranges : [{ text, start: 0, end: text.length }];
}

function sentenceIndexAtOffset(sentences, offset) {
  if (!sentences.length) return 0;
  const safeOffset = Math.max(0, Number(offset) || 0);
  const found = sentences.findIndex((sentence) => safeOffset < sentence.end);
  return found === -1 ? sentences.length - 1 : found;
}

function charOffsetAtPlaybackPosition(boundaries, positionMillis, sourceLength) {
  if (!Array.isArray(boundaries) || boundaries.length === 0) return null;
  let low = 0;
  let high = boundaries.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (Number(boundaries[mid]?.offsetMs) <= positionMillis) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) return 0;
  const boundary = boundaries[found];
  const start = Math.max(0, Number(boundary.charStart) || 0);
  const end = Math.max(start, Number(boundary.charEnd) || start);
  const duration = Math.max(1, Number(boundary.durationMs) || 1);
  const wordProgress = Math.max(0, Math.min(1, (positionMillis - Number(boundary.offsetMs || 0)) / duration));
  return Math.min(sourceLength, Math.floor(start + (end - start) * wordProgress));
}

// TTS 为减少网络停顿按约 60 字切块；字幕这边任务卡09/11第一阶段要求改成
// 整章连续展示（不再只截取当前块前后约180字的小窗口），所以这里直接把
// 整章的块按原有顺序拼起来返回整章文本，currentStart是当前块开头在整章
// 文本里的字符位置——因为chunks本来就是同一段原文按顺序重新分块得到的
// （mergeParagraphsForNarration只重新分块、不改变字符顺序、不丢内容），
// 拼接顺序等价于原文顺序，currentStart在整章语境下依然准确。朗读位置仍
// 只对应当前音频块（调用方playFrom没有改动），这里只是把展示范围从“一个
// 小窗口”换成“整章”，不改变播放判断依据。
function buildCaptionContext(chunks, currentIndex) {
  const safeChunks = Array.isArray(chunks) ? chunks : [];
  if (!safeChunks.length) return { text: '', currentStart: 0 };
  const index = Math.max(0, Math.min(currentIndex, safeChunks.length - 1));
  const before = safeChunks.slice(0, index).join('');
  return {
    text: safeChunks.join(''),
    currentStart: before.length,
  };
}

// 任务卡09/11第一阶段：去掉原来"当前句字号从16.5插值到19.5"那组动画
// （真机反馈换句时字号跳动导致"眼睛失焦"），只保留念过/正在念/未念三档
// 透明度区分，字号统一用styles.captionParagraphText里定义的固定值。
// 另外，句子从原来嵌套在同一个<Text>里的inline span，改成一行
// flexDirection+flexWrap的同级<Text>（每句独立一个盒子）——不是纯视觉
// 调整，是为了让"整章连续滚动+自动居中"能拿到每一句自己的屏幕位置：
// 嵌套在同一个<Text>内部的inline span在RN里普遍不支持onLayout，只有
// 顶层Text/View才能测量；拆成同级盒子后每句都能报告自己的y坐标，父级
// ListenScreen才能算出"把这句滚到屏幕中间"要滚动到哪个位置。
// 第四阶段改为FlatList完整句子项，由原生列表按下标居中；不再依赖安卓
// flexWrap文字的像素坐标，也不再把一句话拆成多个短语定位。
function NarrationSentenceRow({ sentence, index, activeIndex, candidateIndex, rowRef, onConfirm }) {
  const isCandidate = candidateIndex === index;
  const visualState = captionVisualStateForSentence(index, activeIndex);
  return (
    <View ref={rowRef} style={[styles.captionSentenceRow, isCandidate && styles.captionSentenceRowCandidate]}>
      <Text
        suppressHighlighting
        style={[styles.captionParagraphText, styles.captionSentenceText, narrationPhraseStyle(visualState)]}
      >
        {sentence.text}
      </Text>
      {isCandidate && (
        <View style={styles.captionJumpButtonSlot}>
          <TouchableOpacity
            style={styles.captionJumpButton}
            hitSlop={{ top: 7, bottom: 7, left: 7, right: 7 }}
            onPress={() => onConfirm?.(index)}
            accessibilityRole="button"
            accessibilityLabel="从这句话开始播放"
          >
            <IconPlayerPlayFilled color={EMBER.paperDim} size={12} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function narrationPhraseStyle(visualState) {
  if (visualState === 1) {
    return { color: EMBER.paper, opacity: 1, fontWeight: '400' };
  }
  if (visualState === 0) {
    return { color: EMBER.paperDim, opacity: 0.58, fontWeight: '400' };
  }
  return { color: EMBER.inkSoft, opacity: 0.74, fontWeight: '400' };
}

function ListenAnswerText({ text, sources, style }) {
  const sourceByIndex = useMemo(() => {
    const map = {};
    (sources || []).forEach((source) => {
      if (source.index != null) map[Number(source.index)] = source;
    });
    return map;
  }, [sources]);
  const parts = useMemo(() => String(text || '').split(/(\[\d+\])/g), [text]);
  return (
    <Text style={style}>
      {parts.map((part, index) => {
        const match = part.match(/^\[(\d+)\]$/);
        const source = match ? sourceByIndex[Number(match[1])] : null;
        return source?.url ? (
          <Text
            key={`${part}-${index}`}
            style={styles.listenCitationMark}
            onPress={() => Linking.openURL(source.url).catch(() => {})}
          >
            {part}
          </Text>
        ) : part;
      })}
    </Text>
  );
}

function ListenSourcesRow({ sources }) {
  const [expanded, setExpanded] = useState(false);
  if (!sources?.length) return null;
  return (
    <View style={styles.listenSourcesWrap}>
      <TouchableOpacity style={styles.listenSourcesToggle} onPress={() => setExpanded((value) => !value)}>
        <Text style={styles.listenSourcesToggleText}>
          {expanded ? '收起来源' : `查看来源（${sources.length}）`}
        </Text>
      </TouchableOpacity>
      {expanded && sources.map((source, index) => (
        <TouchableOpacity
          key={`${source.url || source.title}-${index}`}
          style={styles.listenSourceItem}
          disabled={!source.url}
          onPress={() => source.url && Linking.openURL(source.url).catch(() => {})}
        >
          <Text style={styles.listenSourceIndex}>[{source.index ?? index + 1}]</Text>
          <View style={styles.listenSourceBody}>
            <Text style={styles.listenSourceTitle} numberOfLines={1}>
              {source.title || source.siteName || '网页来源'}
            </Text>
            {!!source.url && <Text style={styles.listenSourceUrl} numberOfLines={1}>{source.url}</Text>}
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function ListenAtmosphere() {
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs>
        <LinearGradient id="listenBase" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#18191c" />
          <Stop offset="0.48" stopColor="#111214" />
          <Stop offset="1" stopColor="#0d0e10" />
        </LinearGradient>
        <RadialGradient id="listenWarmGlow" cx="50%" cy="2%" rx="72%" ry="48%">
          <Stop offset="0" stopColor="#b17c43" stopOpacity="0.11" />
          <Stop offset="0.52" stopColor="#6f4e2d" stopOpacity="0.035" />
          <Stop offset="1" stopColor="#101113" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="listenLowerGlow" cx="18%" cy="94%" rx="62%" ry="42%">
          <Stop offset="0" stopColor="#6f4e2d" stopOpacity="0.04" />
          <Stop offset="1" stopColor="#101113" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#listenBase)" />
      <Rect width="100%" height="100%" fill="url(#listenWarmGlow)" />
      <Rect width="100%" height="100%" fill="url(#listenLowerGlow)" />
    </Svg>
  );
}

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
  // 听书正文保留完整段落，由TTS播放进度驱动当前句高亮和已读句淡出。
  // "正在朗读…"文案，这次改成显示当前实际在念的那一段文字本身，跟
  // progressLabel在同一处更新（真正开始出声那一刻，不是还在加载的时候，
  // 见onAudioStart回调的既有注释）。currentSegCount记"当前第几段/共几段"，
  // 拿来算进度条位置和"句 X/Y"这个计数，复用同一份数据不重复维护。
  const [currentCaption, setCurrentCaption] = useState('');
  const [captionSentenceIndex, setCaptionSentenceIndex] = useState(0);
  const [candidateSentenceIndex, setCandidateSentenceIndex] = useState(null);
  const captionSentences = useMemo(() => splitCaptionSentences(currentCaption), [currentCaption]);
  const [currentSegCount, setCurrentSegCount] = useState({ idx: 0, total: 0 });
  // 播放/暂停按钮的"暂停"是纯音频暂停，不进对话视图（见handleInterrupt
  // 旁边togglePlayPause的注释）——每次真正有新的一段开始播放都要重置回
  // false，不然上一段暂停过的状态会误跟着下一段。
  const [isManuallyPaused, setIsManuallyPaused] = useState(false);
  const [capturedText, setCapturedText] = useState('');
  const capturedHeardContextRef = useRef('');
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
  // 语音提问现在是听书页的默认能力：进入页面就展示长按麦克风，不再经过
  // “进入语音提问”的二级入口。MANUAL_HOLD_TO_TALK模式下只有实际长按时
  // 才申请权限并开始录音，默认常驻按钮不等于后台持续收音。
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(true);
  const [handsFreeMuted, setHandsFreeMuted] = useState(true);
  const [handsFreeStatus, setHandsFreeStatus] = useState('');
  const [voiceMicError, setVoiceMicError] = useState('');
  // 免提"一轮对话"独立状态机：''表示没有正在进行的免提轮次（这时候ambient
  // 的VAD监听按老逻辑跑），非空表示正在经历"暂停朗读→听问题→AI思考→
  // 念回答"这一整套流程，全程停留在朗读字幕这个视图里，不跳phase。
  // 命名前缀hf（hands-free），跟方案A的auto*/方案B旧的vad*/手动的
  // recordingRef等等这些完全不共用，就是要做到用户明确要求的"两条线互不
  // 干扰"。
  const [hfStage, setHfStage] = useState(''); // '' | 'listening' | 'transcribing' | 'searching' | 'thinking' | 'replying'
  const [hfReplyMuted, setHfReplyMuted] = useState(false);
  const [voiceMessages, setVoiceMessages] = useState([]);
  const [conversationExpanded, setConversationExpanded] = useState(false);
  const [conversationDrawerMounted, setConversationDrawerMounted] = useState(false);
  const [mainStageHeight, setMainStageHeight] = useState(0);
  const [captionViewportHeight, setCaptionViewportHeight] = useState(0);
  const conversationDrawerProgress = useRef(new Animated.Value(0)).current;
  const micVisualProgress = useRef(new Animated.Value(0)).current;
  const micLevelProgress = useRef(new Animated.Value(0)).current;
  const voiceMessageIdRef = useRef(0);
  const voiceConversationRef = useRef(null);
  const voiceAutoScrollRef = useRef(true);

  // Android 对 ScrollView 内 flexWrap 文字的坐标报告不稳定。字幕改为完整句子
  // FlatList 后，自动跟随只依赖稳定的句子下标，由原生列表把目标项放到 50%。
  const captionScrollRef = useRef(null);
  const captionSentenceNodesRef = useRef({});
  const captionVisibleSentenceIndexesRef = useRef([]);
  const captionSentencesRef = useRef(captionSentences);
  const captionSentenceIndexRef = useRef(captionSentenceIndex);
  const captionViewportHeightRef = useRef(0);
  const captionUserScrollingRef = useRef(false);
  const captionIdleTimerRef = useRef(null);
  const captionMomentumWaitRef = useRef(null);
  const captionMomentumSafetyRef = useRef(null);
  const captionMomentumActiveRef = useRef(false);
  const captionProgrammaticScrollUntilRef = useRef(0);
  const captionCandidateDwellTimerRef = useRef(null);
  const captionFollowRetryTimersRef = useRef([]);
  const candidateSentenceIndexRef = useRef(null);
  const captionForceRealignRef = useRef(true);
  useEffect(() => { captionSentencesRef.current = captionSentences; }, [captionSentences]);
  useEffect(() => { captionSentenceIndexRef.current = captionSentenceIndex; }, [captionSentenceIndex]);

  const clearCaptionIdleTimer = useCallback(() => {
    if (captionIdleTimerRef.current) clearTimeout(captionIdleTimerRef.current);
    captionIdleTimerRef.current = null;
  }, []);
  const clearCaptionMomentumWait = useCallback(() => {
    if (captionMomentumWaitRef.current) clearTimeout(captionMomentumWaitRef.current);
    captionMomentumWaitRef.current = null;
  }, []);
  const clearCaptionMomentumSafety = useCallback(() => {
    if (captionMomentumSafetyRef.current) clearTimeout(captionMomentumSafetyRef.current);
    captionMomentumSafetyRef.current = null;
  }, []);
  const clearCaptionCandidateDwell = useCallback(() => {
    if (captionCandidateDwellTimerRef.current) clearTimeout(captionCandidateDwellTimerRef.current);
    captionCandidateDwellTimerRef.current = null;
  }, []);
  const clearCaptionFollowRetries = useCallback(() => {
    captionFollowRetryTimersRef.current.forEach(clearTimeout);
    captionFollowRetryTimersRef.current = [];
  }, []);

  const scrollCaptionToSentence = useCallback((rawIndex, animated = true) => {
    if (captionUserScrollingRef.current) return false;
    const count = captionSentencesRef.current.length;
    const index = Math.max(0, Math.min(Number(rawIndex) || 0, count - 1));
    if (!count || !captionScrollRef.current) return false;
    const useAnimation = animated;
    captionProgrammaticScrollUntilRef.current = Date.now() + (useAnimation ? 1000 : 180);
    try {
      captionScrollRef.current.scrollToIndex({ index, viewPosition: 0.5, animated: useAnimation });
      return true;
    } catch (_) {
      return false;
    }
  }, []);

  const followCaptionSentence = useCallback((index, animated = true) => {
    if (captionUserScrollingRef.current) return;
    clearCaptionFollowRetries();
    [0, 120, 360].forEach((delay) => {
      const timer = setTimeout(() => {
        captionFollowRetryTimersRef.current = captionFollowRetryTimersRef.current
          .filter((item) => item !== timer);
        if (captionUserScrollingRef.current || index !== captionSentenceIndexRef.current) return;
        scrollCaptionToSentence(index, delay === 0 ? animated : false);
      }, delay);
      captionFollowRetryTimersRef.current.push(timer);
    });
  }, [clearCaptionFollowRetries, scrollCaptionToSentence]);

  const startCaptionIdleTimer = useCallback(() => {
    clearCaptionIdleTimer();
    captionIdleTimerRef.current = setTimeout(() => {
      captionIdleTimerRef.current = null;
      candidateSentenceIndexRef.current = null;
      setCandidateSentenceIndex(null);
      captionUserScrollingRef.current = false;
      requestAnimationFrame(() => followCaptionSentence(captionSentenceIndexRef.current, true));
    }, CAPTION_IDLE_SNAPBACK_MS);
  }, [clearCaptionIdleTimer, followCaptionSentence]);

  const clearCaptionCandidate = useCallback((restartSnapback = false) => {
    candidateSentenceIndexRef.current = null;
    setCandidateSentenceIndex(null);
    if (restartSnapback) startCaptionIdleTimer();
  }, [startCaptionIdleTimer]);

  const selectCaptionCandidate = useCallback((sentenceIndex) => {
    if (phase !== 'playing' || captionMomentumActiveRef.current) return;
    candidateSentenceIndexRef.current = sentenceIndex;
    setCandidateSentenceIndex(sentenceIndex);
    captionUserScrollingRef.current = true;
    startCaptionIdleTimer();
  }, [phase, startCaptionIdleTimer]);

  const selectCenteredCaptionCandidate = useCallback(() => {
    if (!captionUserScrollingRef.current || captionMomentumActiveRef.current) return;
    const visible = captionVisibleSentenceIndexesRef.current;
    if (!visible.length) return;
    const fallbackIndex = visible[Math.floor(visible.length / 2)];
    const listNode = captionScrollRef.current?.getNativeScrollRef?.();
    if (!listNode?.measureInWindow) {
      selectCaptionCandidate(fallbackIndex);
      return;
    }
    listNode.measureInWindow((_x, listY, _w, listHeight) => {
      const centerY = listY + listHeight / 2;
      let pending = visible.length;
      let bestIndex = fallbackIndex;
      let bestDistance = Number.POSITIVE_INFINITY;
      visible.forEach((index) => {
        const node = captionSentenceNodesRef.current[index];
        if (!node?.measureInWindow) {
          pending -= 1;
          if (pending === 0) selectCaptionCandidate(bestIndex);
          return;
        }
        node.measureInWindow((_rowX, rowY, _rowW, rowHeight) => {
          const distance = Math.abs(rowY + rowHeight / 2 - centerY);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
          pending -= 1;
          if (pending === 0) selectCaptionCandidate(bestIndex);
        });
      });
    });
  }, [selectCaptionCandidate]);

  const scheduleCenteredCaptionCandidate = useCallback(() => {
    clearCaptionCandidateDwell();
    captionCandidateDwellTimerRef.current = setTimeout(() => {
      captionCandidateDwellTimerRef.current = null;
      selectCenteredCaptionCandidate();
    }, CAPTION_CANDIDATE_DWELL_MS);
  }, [clearCaptionCandidateDwell, selectCenteredCaptionCandidate]);

  const forceCaptionVisualAlignment = useCallback((index = captionSentenceIndexRef.current) => {
    clearCaptionCandidate(false);
    captionUserScrollingRef.current = false;
    captionMomentumActiveRef.current = false;
    clearCaptionIdleTimer();
    clearCaptionMomentumWait();
    clearCaptionMomentumSafety();
    followCaptionSentence(index, false);
  }, [clearCaptionCandidate, clearCaptionIdleTimer, clearCaptionMomentumSafety, clearCaptionMomentumWait, followCaptionSentence]);

  const armCaptionMomentumSafety = useCallback(() => {
    clearCaptionMomentumSafety();
    captionMomentumSafetyRef.current = setTimeout(() => {
      captionMomentumSafetyRef.current = null;
      captionMomentumActiveRef.current = false;
      scheduleCenteredCaptionCandidate();
      startCaptionIdleTimer();
    }, CAPTION_MOMENTUM_SAFETY_MS);
  }, [clearCaptionMomentumSafety, scheduleCenteredCaptionCandidate, startCaptionIdleTimer]);

  const handleCaptionScrollBeginDrag = useCallback(() => {
    captionProgrammaticScrollUntilRef.current = 0;
    clearCaptionCandidate(false);
    captionUserScrollingRef.current = true;
    captionMomentumActiveRef.current = false;
    clearCaptionIdleTimer();
    clearCaptionCandidateDwell();
    clearCaptionFollowRetries();
    clearCaptionMomentumWait();
    clearCaptionMomentumSafety();
  }, [clearCaptionCandidate, clearCaptionCandidateDwell, clearCaptionFollowRetries, clearCaptionIdleTimer, clearCaptionMomentumSafety, clearCaptionMomentumWait]);
  const handleCaptionScrollEndDrag = useCallback(() => {
    clearCaptionMomentumWait();
    captionMomentumWaitRef.current = setTimeout(() => {
      captionMomentumWaitRef.current = null;
      if (!captionMomentumActiveRef.current) {
        scheduleCenteredCaptionCandidate();
        startCaptionIdleTimer();
      }
    }, CAPTION_MOMENTUM_WAIT_MS);
  }, [clearCaptionMomentumWait, scheduleCenteredCaptionCandidate, startCaptionIdleTimer]);
  const handleCaptionMomentumScrollBegin = useCallback(() => {
    if (Date.now() < captionProgrammaticScrollUntilRef.current) return;
    captionMomentumActiveRef.current = true;
    clearCaptionMomentumWait();
    clearCaptionIdleTimer();
    armCaptionMomentumSafety();
  }, [armCaptionMomentumSafety, clearCaptionIdleTimer, clearCaptionMomentumWait]);
  const handleCaptionMomentumScrollEnd = useCallback(() => {
    if (Date.now() < captionProgrammaticScrollUntilRef.current) return;
    clearCaptionMomentumSafety();
    captionMomentumActiveRef.current = false;
    scheduleCenteredCaptionCandidate();
    startCaptionIdleTimer();
  }, [clearCaptionMomentumSafety, scheduleCenteredCaptionCandidate, startCaptionIdleTimer]);
  const handleCaptionViewableItemsChanged = useRef(({ viewableItems }) => {
    captionVisibleSentenceIndexesRef.current = viewableItems
      .map((item) => item.index)
      .filter((index) => Number.isInteger(index))
      .sort((a, b) => a - b);
  }).current;
  const captionViewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 1 }).current;
  const handleCaptionScrollToIndexFailed = useCallback(({ index, averageItemLength }) => {
    if (captionUserScrollingRef.current || !captionScrollRef.current) return;
    captionScrollRef.current.scrollToOffset({
      offset: Math.max(0, averageItemLength * index),
      animated: false,
    });
    setTimeout(() => scrollCaptionToSentence(index, false), 80);
  }, [scrollCaptionToSentence]);

  useEffect(() => {
    captionSentenceNodesRef.current = {};
    captionVisibleSentenceIndexesRef.current = [];
    clearCaptionCandidate(false);
    requestAnimationFrame(() => followCaptionSentence(captionSentenceIndexRef.current, false));
  }, [currentCaption, clearCaptionCandidate, followCaptionSentence]);
  useEffect(() => {
    if (captionUserScrollingRef.current) return undefined;
    followCaptionSentence(captionSentenceIndex, true);
    return clearCaptionFollowRetries;
  }, [captionSentenceIndex, currentCaption, clearCaptionFollowRetries, followCaptionSentence]);
  useEffect(() => {
    if (Platform.OS !== 'android' || phase !== 'playing') return undefined;
    const interval = setInterval(() => {
      if (captionUserScrollingRef.current || hfActiveRef.current) return;
      scrollCaptionToSentence(captionSentenceIndexRef.current, false);
    }, ANDROID_CAPTION_FOLLOW_WATCHDOG_MS);
    return () => clearInterval(interval);
  }, [phase, scrollCaptionToSentence]);

  // playOneParagraph在playFrom的异步循环里调用，如果直接读voice/rate这两个
  // state会有闭包过期的问题（循环开始时闭包捕获的是当时的值，用户中途在
  // 设置面板改了声音，正在进行的循环感知不到）——用ref同步更新，效果是
  // "下一句开始播放就用新设置"，不用整个重启听书。
  const rateRef = useRef(rate);
  const voiceRef = useRef(voice);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => {
    if (conversationExpanded) setConversationDrawerMounted(true);
    const animation = Animated.timing(conversationDrawerProgress, {
      toValue: conversationExpanded ? 1 : 0,
      duration: 360,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !conversationExpanded) setConversationDrawerMounted(false);
    });
    return () => animation.stop();
  }, [conversationDrawerProgress, conversationExpanded]);
  useEffect(() => {
    const listening = hfStage === 'listening';
    if (!listening) micLevelProgress.setValue(0);
    const animation = Animated.timing(micVisualProgress, {
      toValue: listening ? 1 : 0,
      duration: listening ? 80 : 200,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [hfStage, micLevelProgress, micVisualProgress]);

  const chaptersRef = useRef([]); // 已经过滤掉"目录"章节的列表
  const standardChaptersRef = useRef(false);
  const paragraphCacheRef = useRef({}); // chapterId -> string[]
  const chapterLoadPromisesRef = useRef({}); // chapterId -> Promise<string[]>
  const epochRef = useRef(0); // 每次打断/停止自增，让还没awaitresolve的加载能认出自己过期
  const soundRef = useRef(null);
  const lastNarrationFinishedAtRef = useRef(0);
  const playbackRecoveryBusyRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const phaseRef = useRef(phase);
  const manuallyPausedRef = useRef(isManuallyPaused);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { manuallyPausedRef.current = isManuallyPaused; }, [isManuallyPaused]);
  // 真机反馈"段跟段之间停顿太长"——加预取：当前段刚开始出声，就在后台
  // 把下一段的TTS请求发出去，让加载时间跟当前段的播放时间重叠。跟
  // BookChatScreen"预取下一句"是同一个思路，但这边是ListenScreen自己的
  // 单线顺序循环（没有并发enqueue触发多次预取的场景），不会重演那边
  // 排查过的乱序/丢句那类问题——按位置(ci,pi)+voice+rate做匹配校验，
  // 位置或设置对不上就整个丢弃重新现场加载，不会把过期音频当成当前段播。
  const preparedRef = useRef(null); // { ci, pi, voice, rate, promise }
  const posRef = useRef({ chapterIdx: 0, paragraphIdx: 0 }); // 当前/暂停时的位置
  const paragraphProgressRef = useRef({ chapterIdx: 0, paragraphIdx: 0, charOffset: 0 });
  const listenSessionIdRef = useRef(`listen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const promptHistoryRef = useRef([]);
  const continuityReadyRef = useRef(false);
  const progressSaveTimerRef = useRef(null);
  const lastProgressSaveAtRef = useRef(0);
  const lastProgressSignatureRef = useRef('');
  const progressWriteChainRef = useRef(Promise.resolve());
  const persistListenProgressRef = useRef(null);
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
  const hfAmbientNoiseFloorRef = useRef(-60);
  const hfAmbientPeakDbRef = useRef(-160);
  const hfLastTriggerAtRef = useRef(0);
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
  const voiceHoldActiveRef = useRef(false);
  const micGestureHandlersRef = useRef({ grant: null, release: null, cancel: null });
  const drawerGestureHandlersRef = useRef({ expand: null, collapse: null, toggle: null });
  const hfAbortRef = useRef(null);
  // 正文和 AI 回复必须各自拥有音频引用。此前共用 soundRef，回答收尾时
  // “清空引用”和“原生 unload 真正完成”之间存在窗口，Android 上会在正文
  // 已恢复后仍听到 AI 尾音，甚至让下一段回复与正文同时播放。
  const hfReplySoundRef = useRef(null);
  const hfReplyMutedRef = useRef(false);
  const hfReplyInterruptingRef = useRef(false);
  const hfTimingRef = useRef(null);
  const hfResumePendingRef = useRef(false);

  function buildListenProgressSnapshot() {
    const progress = paragraphProgressRef.current;
    const chapter = chaptersRef.current[progress.chapterIdx] || chaptersRef.current[posRef.current.chapterIdx];
    if (!chapter) return null;
    const chapterId = Number(chapter.id);
    return {
      chapter_kind: standardChaptersRef.current ? 'standard' : 'chapter',
      chapter_id: Number.isFinite(chapterId) ? chapterId : null,
      chapter_title: chapter.title || '',
      paragraph_index: Math.max(0, Number(progress.paragraphIdx) || 0),
      char_offset: Math.max(0, Number(progress.charOffset) || 0),
      voice: voiceRef.current,
      rate: rateRef.current,
    };
  }

  async function flushListenProgress(reason = 'manual', force = false) {
    if (progressSaveTimerRef.current) {
      clearTimeout(progressSaveTimerRef.current);
      progressSaveTimerRef.current = null;
    }
    if (!continuityReadyRef.current) return;
    const snapshot = buildListenProgressSnapshot();
    if (!snapshot) return;
    const signature = JSON.stringify(snapshot);
    if (!force && signature === lastProgressSignatureRef.current) return;
    lastProgressSignatureRef.current = signature;
    lastProgressSaveAtRef.current = Date.now();
    progressWriteChainRef.current = progressWriteChainRef.current
      .catch(() => {})
      .then(async () => {
        try {
          await saveListenProgress(bookId, snapshot);
          console.log(`[听书连续性] 已保存(${reason}) ${snapshot.chapter_id}/${snapshot.paragraph_index}/${snapshot.char_offset}`);
        } catch (e) {
          // saveListenProgress 会先写用户隔离的本地副本；远端失败不应打断播放。
          console.log(`[听书连续性] 远端保存失败，本地副本已保留(${reason})：${e.message || e}`);
        }
      });
    await progressWriteChainRef.current;
  }

  function scheduleListenProgressSave(reason = 'playback') {
    if (!continuityReadyRef.current || progressSaveTimerRef.current) return;
    const elapsed = Date.now() - lastProgressSaveAtRef.current;
    const delay = Math.max(200, LISTEN_PROGRESS_SAVE_INTERVAL_MS - elapsed);
    progressSaveTimerRef.current = setTimeout(() => {
      progressSaveTimerRef.current = null;
      flushListenProgress(reason);
    }, delay);
  }

  function rememberPromptTurn(questionText, answerText) {
    promptHistoryRef.current = appendPromptTurn(
      promptHistoryRef.current,
      questionText,
      answerText,
      LISTEN_HISTORY_TURNS * 2,
    );
  }

  persistListenProgressRef.current = flushListenProgress;

  function formatHfMs(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function buildHfTimingSummary(timing) {
    if (!timing?.marks) return '';
    const m = timing.marks;
    const parts = [];
    if (m.recording_started && m.endpoint_end) {
      parts.push(`录音${formatHfMs(m.endpoint_end - m.recording_started)}`);
    }
    if (m.asr_start && m.asr_end) parts.push(`ASR${formatHfMs(m.asr_end - m.asr_start)}`);
    if (m.intent_start && m.intent_end) parts.push(`意图${formatHfMs(m.intent_end - m.intent_start)}`);
    if (m.llm_start && m.llm_first_delta) parts.push(`首字${formatHfMs(m.llm_first_delta - m.llm_start)}`);
    if (m.llm_start && m.llm_done) parts.push(`回答${formatHfMs(m.llm_done - m.llm_start)}`);
    const ttsWaitStart = m.first_tts_enqueue || m.llm_done;
    if (ttsWaitStart && m.answer_audio_start) parts.push(`TTS出声${formatHfMs(m.answer_audio_start - ttsWaitStart)}`);
    if (m.answer_audio_start && m.answer_play_end) parts.push(`播放${formatHfMs(m.answer_play_end - m.answer_audio_start)}`);
    if (m.resume_start && m.resume_audio_start) parts.push(`续播${formatHfMs(m.resume_audio_start - m.resume_start)}`);
    if (m.start) parts.push(`总计${formatHfMs((m.resume_audio_start || timing.lastAt) - m.start)}`);
    return parts.length ? `本轮耗时：${parts.join(' / ')}` : '';
  }

  function buildHfTimingMetrics(timing) {
    const m = timing?.marks || {};
    const diff = (from, to) => (
      m[from] && m[to] ? Math.max(0, m[to] - m[from]) : null
    );
    const totalEnd = m.resume_audio_start || timing?.lastAt || null;
    return {
      recording_ms: diff('recording_started', 'endpoint_end'),
      asr_ms: diff('asr_start', 'asr_end'),
      asr_server_transcode_ms: timing?.meta?.asrServerTranscodeMs ?? null,
      asr_provider_ms: timing?.meta?.asrProviderMs ?? null,
      asr_transport_ms: (
        Number.isFinite(timing?.meta?.asrServerTranscodeMs)
        && Number.isFinite(timing?.meta?.asrProviderMs)
        && Number.isFinite(diff('asr_start', 'asr_end'))
      ) ? Math.max(0, diff('asr_start', 'asr_end')
        - timing.meta.asrServerTranscodeMs - timing.meta.asrProviderMs) : null,
      intent_ms: diff('intent_start', 'intent_end'),
      llm_first_delta_ms: diff('llm_start', 'llm_first_delta'),
      llm_first_sentence_ms: diff('llm_start', 'first_tts_enqueue'),
      llm_delta_to_sentence_ms: diff('llm_first_delta', 'first_tts_enqueue'),
      llm_total_ms: diff('llm_start', 'llm_done'),
      tts_to_audio_start_ms: diff(m.first_tts_enqueue ? 'first_tts_enqueue' : 'llm_done', 'answer_audio_start'),
      tts_audio_mode_ms: diff('first_tts_audio_mode_start', 'first_tts_audio_mode_end'),
      tts_load_ms: diff('first_tts_load_start', 'first_tts_load_end'),
      tts_play_start_ms: diff('first_tts_play_request', 'answer_audio_start'),
      answer_play_ms: diff('answer_audio_start', 'answer_play_end'),
      resume_to_audio_start_ms: diff('resume_start', 'resume_audio_start'),
      total_ms: m.start && totalEnd ? Math.max(0, totalEnd - m.start) : null,
    };
  }

  function uploadHfTiming(timing, summary, final = false) {
    if (!summary || !timing?.marks) return;
    submitVoiceLatencyMetric({
      book_id: String(bookId || ''),
      book_title: bookTitle || '',
      chapter_title: chapterTitle || '',
      platform: Platform.OS,
      reason: timing.reason || '',
      summary,
      metrics: buildHfTimingMetrics(timing),
      meta: { ...(timing.meta || {}), final },
    }).catch((e) => {
      console.log(`[免提计时汇总] 后台上报失败：${e.message || e}`);
    });
  }

  function setHfTimingMeta(patch) {
    if (!hfTimingRef.current) return;
    hfTimingRef.current.meta = { ...(hfTimingRef.current.meta || {}), ...patch };
  }

  function snapshotHfTiming(label = null) {
    if (label) markHfTiming(label);
    const timing = hfTimingRef.current;
    const summary = buildHfTimingSummary(timing);
    if (summary) {
      console.log(`[免提计时汇总] ${summary}`);
      uploadHfTiming(timing, summary, false);
    }
  }

  function finishHfTiming(label) {
    if (label) markHfTiming(label);
    const timing = hfTimingRef.current;
    const summary = buildHfTimingSummary(timing);
    if (summary) {
      console.log(`[免提计时汇总] ${summary}`);
      uploadHfTiming(timing, summary, true);
    }
    hfTimingRef.current = null;
    hfResumePendingRef.current = false;
  }

  function startHfTiming(reason) {
    const now = Date.now();
    hfTimingRef.current = { reason, startedAt: now, lastAt: now, marks: { start: now } };
    console.log(`[免提计时] ${reason} start`);
  }

  function markHfTiming(label, key = null) {
    const now = Date.now();
    const timing = hfTimingRef.current;
    if (!timing) {
      console.log(`[免提计时] ${label}`);
      return;
    }
    console.log(`[免提计时] ${label}: +${now - timing.lastAt}ms / total ${now - timing.startedAt}ms`);
    if (key) timing.marks[key] = now;
    timing.lastAt = now;
  }

  async function releaseNarrationSound(sound) {
    if (!sound) return;
    const localUri = sound.__banduTimedTtsFileUri;
    // 每个Sound都有自己配套的WordBoundary。切段前先解除旧回调，避免旧音频
    // 最后一帧状态在新Sound已经开始后污染新段的字位/高亮基准。
    try { sound.setOnPlaybackStatusUpdate(null); } catch (_) {}
    await sound.unloadAsync().catch(() => {});
    if (localUri) {
      await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
    }
  }

  async function createTimedNarrationSound(text, voiceName, playbackRate) {
    const response = await getTtsWithTiming(text, voiceName, playbackRate);
    if (!response?.audioBase64 || !Array.isArray(response?.boundaries)) {
      throw new Error('带时间戳TTS返回格式不完整');
    }
    const fileUri = `${FileSystem.cacheDirectory}listen_timed_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
    try {
      await FileSystem.writeAsStringAsync(fileUri, response.audioBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const { sound } = await Audio.Sound.createAsync(
        { uri: fileUri },
        { shouldPlay: false, progressUpdateIntervalMillis: NARRATION_STATUS_INTERVAL_MS },
      );
      // Sound实例只在本页进程内存活；把配对时间线挂在同一个实例上，避免
      // 预取队列把A段音频和B段时间轴拆开。文件URI用于unload后立即清缓存。
      sound.__banduTimedTtsFileUri = fileUri;
      sound.__banduWordBoundaries = response.boundaries;
      sound.__banduNormalizedText = response.normalizedText || text;
      return sound;
    } catch (e) {
      await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      throw e;
    }
  }

  async function createNarrationSound(text, voiceName, playbackRate) {
    try {
      const sound = await createTimedNarrationSound(text, voiceName, playbackRate);
      console.log(`[听书时间轴] 使用真实WordBoundary，边界数=${sound.__banduWordBoundaries.length}`);
      return sound;
    } catch (e) {
      console.log(`[听书时间轴] 新接口失败，降级旧/tts/play：${e.message || e}`);
      const { sound } = await Audio.Sound.createAsync(
        { uri: getTtsPlayUrl(text, voiceName, playbackRate) },
        { shouldPlay: false, progressUpdateIntervalMillis: NARRATION_STATUS_INTERVAL_MS },
      );
      return sound;
    }
  }

  function prepareNarrationSound(chapterIdx, paragraphIdx, text) {
    const voiceName = voiceRef.current;
    const playbackRate = rateRef.current;
    const existing = preparedRef.current;
    if (preparedSoundMatches(existing, {
      chapterIdx, paragraphIdx, voice: voiceName, rate: playbackRate,
    })) return existing.promise;
    if (existing) existing.promise.then((sound) => releaseNarrationSound(sound)).catch(() => {});
    const startedAt = Date.now();
    console.log(`[听书诊断] 预取开始 第${paragraphIdx + 1}段 字数=${text.length}`);
    const promise = createNarrationSound(text, voiceName, playbackRate)
      .then((sound) => {
        console.log(`[听书诊断] 预取完成 第${paragraphIdx + 1}段 耗时${Date.now() - startedAt}ms`);
        return sound;
      })
      .catch((error) => {
        console.log(`[听书诊断] 预取失败 第${paragraphIdx + 1}段 耗时${Date.now() - startedAt}ms：${error.message || error}`);
        // 预取是后台优化，不能制造未处理Promise rejection；返回null让真正
        // 轮到该段时自然走现场加载兜底。
        return null;
      });
    preparedRef.current = {
      ci: chapterIdx, pi: paragraphIdx, voice: voiceName, rate: playbackRate, promise,
    };
    return promise;
  }

  async function stopSound() {
    const sound = soundRef.current;
    soundRef.current = null;
    if (sound) {
      await sound.stopAsync().catch(() => {});
      await releaseNarrationSound(sound);
    }
    // 打断/停止听书时，预取好但还没用上的下一段音频也要一并释放，
    // 不然这份资源没人管，白占着。
    const prepared = preparedRef.current;
    preparedRef.current = null;
    if (prepared) {
      prepared.promise.then((s) => releaseNarrationSound(s)).catch(() => {});
    }
  }

  async function playOneParagraph(text, epoch, onAudioStart, presetSoundPromise, progressMeta = null) {
    let sound = null;
    const t0 = Date.now();
    if (epoch !== epochRef.current) return;
    if (!hfAmbientRecordingRef.current && !hfRecordingRef.current && !recordingRef.current) {
      await restorePlaybackAudioMode().catch(() => {});
    }
    if (epoch !== epochRef.current) return;
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
      sound = progressMeta
        ? await createNarrationSound(text, voiceRef.current, rateRef.current)
        : (await Audio.Sound.createAsync(
          { uri: getTtsPlayUrl(text, voiceRef.current, rateRef.current) },
          { shouldPlay: false, progressUpdateIntervalMillis: NARRATION_STATUS_INTERVAL_MS },
        )).sound;
      console.log(`[听书诊断] 播放段落(现场加载，耗时${Date.now() - t1}ms) voice=${voiceRef.current} rate=${rateRef.current} 字数=${text.length}`);
    }
    if (epoch !== epochRef.current) {
      releaseNarrationSound(sound);
      return;
    }
    soundRef.current = sound;
    let audioStarted = false;
    let audioStartedAt = 0;
    let firstHighlightAt = 0;
    let lastProgressAt = Date.now();
    let lastPositionMillis = -1;
    const notifyAudioStart = () => {
      if (audioStarted || epoch !== epochRef.current || soundRef.current !== sound) return;
      audioStarted = true;
      audioStartedAt = Date.now();
      let silentGapMs = 0;
      if (lastNarrationFinishedAtRef.current > 0) {
        silentGapMs = Date.now() - lastNarrationFinishedAtRef.current;
        console.log(`[听书诊断] 段间实际静默=${silentGapMs}ms`);
        lastNarrationFinishedAtRef.current = 0;
      }
      onAudioStart?.({ silentGapMs });
      console.log(`[听书时间轴] 音频开始 位置=${progressMeta?.chapterIdx ?? '-'}/${progressMeta?.paragraphIdx ?? '-'} t=${audioStartedAt}`);
    };
    await new Promise((resolve, reject) => {
      let settled = false;
      let watchdog = null;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearInterval(watchdog);
        if (error) reject(error);
        else resolve();
      };
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.isLoaded && s.isPlaying) notifyAudioStart();
        if (epoch === epochRef.current && soundRef.current === sound
            && s.isLoaded && progressMeta && s.durationMillis > 0 && s.positionMillis >= 0) {
          if (s.positionMillis !== lastPositionMillis) {
            lastPositionMillis = s.positionMillis;
            lastProgressAt = Date.now();
          }
          const baseOffset = progressMeta.baseOffset || 0;
          const playTextLength = progressMeta.playTextLength || progressMeta.sourceLength || 0;
          const timedOffset = charOffsetAtPlaybackPosition(
            sound.__banduWordBoundaries,
            s.positionMillis,
            playTextLength,
          );
          const ratio = Math.max(0, Math.min(1, s.positionMillis / s.durationMillis));
          const relativeOffset = timedOffset == null
            ? Math.floor(playTextLength * ratio)
            : timedOffset;
          const charOffset = Math.min(progressMeta.sourceLength, baseOffset + relativeOffset);
          paragraphProgressRef.current = {
            chapterIdx: progressMeta.chapterIdx,
            paragraphIdx: progressMeta.paragraphIdx,
            charOffset,
          };
          scheduleListenProgressSave('播放中');
          progressMeta.onCharOffset?.(charOffset);
          if (!firstHighlightAt && audioStartedAt) {
            firstHighlightAt = Date.now();
            console.log(`[听书时间轴] 首个高亮 位置=${progressMeta.chapterIdx}/${progressMeta.paragraphIdx} t=${firstHighlightAt} 与出声差=${firstHighlightAt - audioStartedAt}ms position=${s.positionMillis}ms`);
          }
        }
        if (!s.isLoaded) finish(new Error(s.error || '音频已失效'));
        else if (s.didJustFinish) finish();
      });
      watchdog = setInterval(async () => {
        if (settled || epoch !== epochRef.current || soundRef.current !== sound || manuallyPausedRef.current) return;
        if (Date.now() - lastProgressAt < 5000) return;
        try {
          const status = await sound.getStatusAsync();
          if (!status?.isLoaded) {
            finish(new Error('播放过程中Sound失效'));
          } else if (!status.isPlaying && !status.isBuffering && !status.didJustFinish) {
            finish(new Error(`播放状态停滞 position=${status.positionMillis || 0}`));
          } else {
            // 仍在播放或缓冲时只刷新观察窗口，不把短暂网络/系统调度误判为失败。
            lastProgressAt = Date.now();
          }
        } catch (error) {
          finish(error);
        }
      }, 2500);
      sound.playAsync()
        .then(() => notifyAudioStart())
        .catch((error) => finish(error));
    });
  }

  async function loadNarrationParagraphs(chapter) {
    const data = standardChaptersRef.current
      ? await getStandardChapterText(bookId, chapter.id)
      : await getChapterText(bookId, chapter.id);
    const paragraphs = Array.isArray(data?.paragraphs) ? data.paragraphs : [];
    return mergeParagraphsForNarration(paragraphs);
  }

  function getNarrationParagraphs(chapter) {
    const cached = paragraphCacheRef.current[chapter.id];
    if (cached) return Promise.resolve(cached);
    const inFlight = chapterLoadPromisesRef.current[chapter.id];
    if (inFlight) return inFlight;

    const promise = loadNarrationParagraphs(chapter)
      .then((paragraphs) => {
        paragraphCacheRef.current[chapter.id] = paragraphs;
        return paragraphs;
      })
      .finally(() => {
        if (chapterLoadPromisesRef.current[chapter.id] === promise) {
          delete chapterLoadPromisesRef.current[chapter.id];
        }
      });
    chapterLoadPromisesRef.current[chapter.id] = promise;
    return promise;
  }

  // 从指定位置开始顺序朗读，直到打断（epoch变化）或全书听完。
  // 录音/问答打断后优先按本次音频的WordBoundary保存段内字位；新接口
  // 不可用时才退回播放比例估算。恢复时从该字位前面少量回退继续读，
  // 避免每次都从合并段落开头重读。
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
          paragraphs = await getNarrationParagraphs(chapter);
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
      }
      let paragraphRetryCount = 0;
      while (pi < paragraphs.length) {
        if (epoch !== epochRef.current) {
          console.log(`[听书诊断] epoch过期(${epoch}→${epochRef.current})，播放循环退出，位置=${ci}/${pi}`);
          return;
        }
        setChapterTitle(chapter.title);
        setProgressLabel(`第${pi + 1}/${paragraphs.length}段（加载中…）`);
        manuallyPausedRef.current = false;
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
        if (preparedSoundMatches(prepared, {
          chapterIdx: ci,
          paragraphIdx: pi,
          voice: voiceRef.current,
          rate: rateRef.current,
        })) {
          presetPromise = prepared.promise;
          preparedRef.current = null;
        } else if (prepared) {
          prepared.promise.then((s) => releaseNarrationSound(s)).catch(() => {});
          preparedRef.current = null;
        }

        const resumeProgress = paragraphProgressRef.current;
        const shouldResumeWithinParagraph = resumeProgress.chapterIdx === ci
          && resumeProgress.paragraphIdx === pi
          && resumeProgress.charOffset > RESUME_CHAR_BACKTRACK
          && resumeProgress.charOffset <= paragraphs[pi].length;
        const resumeSlice = shouldResumeWithinParagraph
          ? getResumeSlice(paragraphs[pi], resumeProgress.charOffset)
          : { text: paragraphs[pi], startOffset: 0 };
        const textToPlay = resumeSlice.text;
        const captionContext = buildCaptionContext(paragraphs, pi);
        const captionSentences = splitCaptionSentences(captionContext.text);
        let lastCaptionSentenceIndex = sentenceIndexAtOffset(
          captionSentences,
          captionContext.currentStart + resumeSlice.startOffset,
        );
        if (shouldResumeWithinParagraph) {
          // 段内恢复文本已经变短，不能复用原整段预取音频；这份预取已经
          // 从preparedRef取走，必须在这里释放，不能只把promise变量置空。
          presetPromise?.then((s) => releaseNarrationSound(s)).catch(() => {});
          presetPromise = null;
        }

        // 当前段真正开始出声之前就启动下一段预取。旧实现等到onAudioStart才
        // 发请求，短段落的播放时长经常盖不住TTS网络+落盘时间；提前到这里后，
        // 当前段的加载时间和播放时间都能与下一段合成重叠。
        const nextPi = pi + 1;
        if (nextPi < paragraphs.length) {
          prepareNarrationSound(ci, nextPi, paragraphs[nextPi]);
        }

        const nextChapter = chapters[ci + 1];
        if (nextChapter && nextPi >= paragraphs.length - 1) {
          // 章节边界原来要等本章完全播完，才依次请求下一章正文和首段TTS。
          // 倒数第二段先取正文，最后一段再预取首段音频，让两项网络等待都
          // 藏在当前章仍在朗读的时间里。预取失败不改变主流程，切章时会重试。
          getNarrationParagraphs(nextChapter)
            .then((nextParagraphs) => {
              if (epoch !== epochRef.current || manuallyPausedRef.current || hfActiveRef.current) return;
              if (nextPi >= paragraphs.length && nextParagraphs.length > 0) {
                prepareNarrationSound(ci + 1, 0, nextParagraphs[0]);
              }
            })
            .catch((error) => {
              console.log(`[听书诊断] 下一章预取失败，切章时重试：${error.message || error}`);
            });
        }

        console.log(`[听书诊断] 开始加载 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段 段内恢复=${shouldResumeWithinParagraph} 预取命中=${!!presetPromise}`);
        try {
          await playOneParagraph(textToPlay, epoch, ({ silentGapMs = 0 } = {}) => {
            // 真机反馈过"打断时截取的是刚讲到那段的后面一段，不是刚讲到
            // 的那段"——根因是原来在"这段还没开始出声、还在等TTS合成"
            // 这个加载阶段，就把posRef改成了这一段，用户如果在这段真正
            // 出声之前打断（比如以为卡住了、在10秒静默间隔里点了打断），
            // 截取到的就是用户实际上根本没听到的下一段。改成真正开始
            // 出声这一刻才更新posRef，跟用户耳朵听到的内容对齐。
            posRef.current = { chapterIdx: ci, paragraphIdx: pi };
            if (!shouldResumeWithinParagraph) {
              paragraphProgressRef.current = { chapterIdx: ci, paragraphIdx: pi, charOffset: 0 };
            }
            scheduleListenProgressSave('段落开始');
            setProgressLabel(`第${pi + 1}/${paragraphs.length}段`);
            setCurrentCaption(captionContext.text);
            setCaptionSentenceIndex(lastCaptionSentenceIndex);
            setCurrentSegCount({ idx: pi, total: paragraphs.length });
            const mustRealign = captionForceRealignRef.current || silentGapMs >= CAPTION_STALL_REALIGN_MS;
            captionForceRealignRef.current = false;
            if (mustRealign) {
              forceCaptionVisualAlignment(lastCaptionSentenceIndex);
            }
            console.log(`[听书诊断] 开始出声 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段`);
            if (hfResumePendingRef.current) {
              markHfTiming('正文恢复开始播放', 'resume_audio_start');
              finishHfTiming();
            }
          }, presetPromise, {
            chapterIdx: ci,
            paragraphIdx: pi,
            sourceLength: paragraphs[pi].length,
            baseOffset: resumeSlice.startOffset,
            playTextLength: textToPlay.length,
            onCharOffset: (charOffset) => {
              const globalOffset = captionContext.currentStart + charOffset;
              const nextSentenceIndex = sentenceIndexAtOffset(
                captionSentences,
                globalOffset,
              );
              if (nextSentenceIndex !== lastCaptionSentenceIndex) {
                lastCaptionSentenceIndex = nextSentenceIndex;
                setCaptionSentenceIndex(nextSentenceIndex);
              }
            },
          });
          console.log(`[听书诊断] 播放完成 章节="${chapter.title}" 第${pi + 1}/${paragraphs.length}段`);
          lastNarrationFinishedAtRef.current = Date.now();
        } catch (e) {
          console.log(`[听书诊断] 播放出错 位置=${ci}/${pi} 重试=${paragraphRetryCount}：${e.message || e}`);
          const failedSound = soundRef.current;
          if (failedSound) {
            soundRef.current = null;
            await releaseNarrationSound(failedSound);
          }
          if (epoch !== epochRef.current) return;
          if (paragraphRetryCount < 1) {
            paragraphRetryCount += 1;
            captionForceRealignRef.current = true;
            await restorePlaybackAudioMode().catch(() => {});
            continue;
          }
          setErrorMsg('朗读暂时中断，请点播放键从当前位置继续');
          manuallyPausedRef.current = true;
          setIsManuallyPaused(true);
          return;
        }
        paragraphRetryCount = 0;
        if (epoch !== epochRef.current) return;
        const finishedSound = soundRef.current;
        if (finishedSound) {
          soundRef.current = null;
          finishedSound.setOnPlaybackStatusUpdate(null);
          releaseNarrationSound(finishedSound);
        }
        if (pi + 1 < paragraphs.length) {
          posRef.current = { chapterIdx: ci, paragraphIdx: pi + 1 };
          paragraphProgressRef.current = { chapterIdx: ci, paragraphIdx: pi + 1, charOffset: 0 };
        } else if (ci + 1 < chapters.length) {
          posRef.current = { chapterIdx: ci + 1, paragraphIdx: 0 };
          paragraphProgressRef.current = { chapterIdx: ci + 1, paragraphIdx: 0, charOffset: 0 };
        }
        flushListenProgress('段落切换', true);
        pi += 1;
      }
      console.log(`[听书诊断] 章节"${chapter.title}"全部段落播完，切下一章`);
      ci += 1;
      pi = 0;
    }
    console.log('[听书诊断] 全书播放完毕');
    if (epoch === epochRef.current) setPhase('done');
  }, [bookId]);

  function restartNarrationFromCurrent(reason = '手动恢复正文播放') {
    const { chapterIdx, paragraphIdx } = posRef.current;
    captionForceRealignRef.current = true;
    epochRef.current += 1;
    const epoch = epochRef.current;
    console.log(`[听书诊断] ${reason} chapter=${chapterIdx} paragraph=${paragraphIdx}`);
    manuallyPausedRef.current = false;
    setIsManuallyPaused(false);
    return (async () => {
      await stopSound();
      await restorePlaybackAudioMode().catch(() => {});
      return playFrom(chapterIdx, paragraphIdx, epoch);
    })();
  }

  async function recoverNarrationPlayback(reason) {
    if (playbackRecoveryBusyRef.current) return;
    playbackRecoveryBusyRef.current = true;
    try {
      const sound = soundRef.current;
      let status = null;
      if (sound) {
        try {
          status = await sound.getStatusAsync();
        } catch (error) {
          console.log(`[听书恢复] 读取sound状态失败(${reason})：${error.message || error}`);
        }
      }
      const action = playbackRecoveryAction({
        status,
        phase: phaseRef.current,
        isManuallyPaused: manuallyPausedRef.current,
        // 语音提问沿用 playing 页面承载字幕，不能只凭 phase 判断正文应恢复。
        // Android 在录音授权/音频模式切换时可能触发 AppState 变化；这道屏障
        // 防止回前台恢复与 ASR/AI TTS 同时启动。
        voiceInteractionActive: hfActiveRef.current
          || !!hfRecordingRef.current
          || !!hfReplySoundRef.current,
      });
      console.log(`[听书恢复] ${reason} action=${action} loaded=${!!status?.isLoaded} playing=${!!status?.isPlaying}`);
      if (action === 'rebuild') {
        await restartNarrationFromCurrent(`${reason}：原生sound失效，按最近字位重建`);
      } else if (action === 'resume') {
        try {
          await restorePlaybackAudioMode();
          await sound.playAsync();
          forceCaptionVisualAlignment();
        } catch (error) {
          console.log(`[听书恢复] 原sound续播失败，改为重建：${error.message || error}`);
          await restartNarrationFromCurrent(`${reason}：原sound续播失败`);
        }
      }
    } finally {
      playbackRecoveryBusyRef.current = false;
    }
  }

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
    if (!changed) return;
    scheduleListenProgressSave('声音或语速变化');
    if (phase !== 'playing') return;
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
      console.log(`[听书诊断] 设置切换：停止旧音频完成，从${chapterIdx}/${paragraphIdx}的已播字符附近续播`);
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
    (async () => {
      Promise.allSettled([getListenHistory(bookId, 12)]).then(([historyResult]) => {
        if (cancelled || historyResult.status !== 'fulfilled') return;
        const restoredHistory = historyRowsToMessages(historyResult.value, LISTEN_HISTORY_TURNS);
        const restoredPrompt = restoredHistory.map(({ role, content }) => ({ role, content }));
        promptHistoryRef.current = [...restoredPrompt, ...promptHistoryRef.current]
          .slice(-(LISTEN_HISTORY_TURNS * 2));
        setVoiceMessages((current) => [
          ...restoredHistory.map((message, index) => ({ ...message, id: `history-${index}` })),
          ...current.filter((message) => !message.historical),
        ]);
      });
      const [contextResult, progressResult] = await Promise.allSettled([
        getBookContext(bookId),
        getListenProgress(bookId),
      ]);
      if (cancelled) return;
      if (contextResult.status !== 'fulfilled') throw contextResult.reason;
      const ctx = contextResult.value;
      const savedProgress = progressResult.status === 'fulfilled' ? progressResult.value?.progress : null;

      const settings = normalizeListenSettings(savedProgress, VOICE_OPTIONS.map((item) => item.value));
      voiceRef.current = settings.voice;
      rateRef.current = settings.rate;
      setVoice(settings.voice);
      setRate(settings.rate);
      setRateDisplay(rateStrToMultiplier(settings.rate));

      standardChaptersRef.current = ctx.source === 'imported' && (ctx.standard_chapters || []).length > 0;
      const sourceChapters = standardChaptersRef.current ? ctx.standard_chapters : ctx.chapters;
      const filtered = (sourceChapters || []).filter((chapter) => !isTocChapter(chapter.title));
      chaptersRef.current = filtered;
      if (filtered.length === 0) {
        setErrorMsg('这本书没有可朗读的章节');
        setPhase('error');
        return;
      }

      const chapterChoice = resolveListenChapter({
        progress: savedProgress,
        chapters: filtered,
        chapterKind: standardChaptersRef.current ? 'standard' : 'chapter',
        initialChapterTitle,
      });
      const targetChapter = filtered[chapterChoice.chapterIdx];
      const initialEpoch = epochRef.current;
      try {
        const paragraphs = await loadNarrationParagraphs(targetChapter);
        if (cancelled || initialEpoch !== epochRef.current) return;
        paragraphCacheRef.current[targetChapter.id] = paragraphs;
        const paragraphChoice = resolveListenParagraph(
          savedProgress,
          paragraphs,
          chapterChoice.useSavedPosition,
          startFraction,
        );
        posRef.current = { chapterIdx: chapterChoice.chapterIdx, paragraphIdx: paragraphChoice.paragraphIdx };
        paragraphProgressRef.current = {
          chapterIdx: chapterChoice.chapterIdx,
          paragraphIdx: paragraphChoice.paragraphIdx,
          charOffset: paragraphChoice.charOffset,
        };
        continuityReadyRef.current = true;
        console.log(`[听书连续性] 恢复来源=${chapterChoice.source}/${paragraphChoice.source}`);
        playFrom(chapterChoice.chapterIdx, paragraphChoice.paragraphIdx, initialEpoch);
      } catch (e) {
        if (cancelled || initialEpoch !== epochRef.current) return;
        posRef.current = { chapterIdx: chapterChoice.chapterIdx, paragraphIdx: 0 };
        paragraphProgressRef.current = { chapterIdx: chapterChoice.chapterIdx, paragraphIdx: 0, charOffset: 0 };
        continuityReadyRef.current = true;
        console.log(`[听书连续性] 精确恢复失败，回退章节开头：${e.message || e}`);
        playFrom(chapterChoice.chapterIdx, 0, initialEpoch);
      }
    })().catch((e) => {
      if (cancelled) return;
      setErrorMsg(e.message || '书本信息加载失败');
      setPhase('error');
    });
    return () => {
      persistListenProgressRef.current?.('离开页面', true);
      cancelled = true;
      continuityReadyRef.current = false;
      epochRef.current += 1;
      stopSound();
      abortAskRef.current?.();
      if (progressSaveTimerRef.current) clearTimeout(progressSaveTimerRef.current);
      if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current);
      if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
      if (captionIdleTimerRef.current) clearTimeout(captionIdleTimerRef.current);
      if (captionMomentumWaitRef.current) clearTimeout(captionMomentumWaitRef.current);
      if (captionMomentumSafetyRef.current) clearTimeout(captionMomentumSafetyRef.current);
      if (captionCandidateDwellTimerRef.current) clearTimeout(captionCandidateDwellTimerRef.current);
      captionFollowRetryTimersRef.current.forEach(clearTimeout);
      if (autoListenRef.current && recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
      cancelHandsFreeTurn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  useEffect(() => {
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState === 'inactive' || nextState === 'background') {
        persistListenProgressRef.current?.('切换后台', true);
      } else if (nextState === 'active' && previousState !== 'active') {
        // Android回前台后给原生音频会话一个很短的恢复窗口，再核对Sound是否
        // 仍loaded/playing。失效就从WordBoundary保存的最近字位重建。
        setTimeout(() => recoverNarrationPlayback('App回到前台'), 120);
      }
    });
    const beforeRemove = navigation.addListener('beforeRemove', () => {
      persistListenProgressRef.current?.('导航离开', true);
    });
    return () => {
      appStateSubscription.remove();
      beforeRemove();
    };
  }, [navigation]);

  function handleInterrupt() {
    if (phase !== 'playing' && phase !== 'loading-chapter') return;
    // 续二十三访客模式：打断听书是为了问AI，属于三个约定触发点里的
    // "AI相关入口"——访客点这个按钮不进对话视图，先弹注册引导。朗读本身
    // （包括听书这个功能的入口）对访客照常开放，只挡这一步。
    if (!requireAuth('ai')) return;
    flushListenProgress('提问打断', true);
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
    // capturedText只用于给用户看"当前问的是这一段"，保持简短；真正发给
    // AI的选段单独存一份完整版（含本章已播完的全部内容），两者分开，
    // 展示不会因为拼了一整章而变成一堵文字墙。
    setCapturedText(paragraphs[paragraphIdx] || '');
    capturedHeardContextRef.current = buildHeardChapterContext(paragraphs, paragraphIdx);
    setQuestion('');
    setConversation(promptHistoryRef.current.map((message) => ({ ...message, historical: true })));
    setPhase('paused');
  }

  // 真机反馈：播放控制那排的播放/暂停按钮之前直接复用了handleInterrupt/
  // handleContinue，点一下暂停就整个进了打断提问的对话视图——用户明确
  // 要求这两个是两码事：暂停应该只是单纯停住/接着播这段音频，原地不动，
  // 不进提问模式；只有专门的"打断，我想问问"按钮才应该进对话视图。改成
  // 直接操作soundRef.current这个正在播放的Sound实例（pauseAsync/playAsync
  // 是expo-av对已加载音频的原生操作，不需要重新合成语音），不碰phase。
  async function togglePlayPause() {
    const sound = soundRef.current;
    if (isManuallyPaused) {
      let status = null;
      try {
        status = sound ? await sound.getStatusAsync() : null;
      } catch (error) {
        console.log(`[听书恢复] 播放键读取sound失败：${error.message || error}`);
      }
      if (!sound || !status?.isLoaded) {
        manuallyPausedRef.current = false;
        setIsManuallyPaused(false);
        await restartNarrationFromCurrent('播放键检测到sound失效');
        return;
      }
      try {
        await restorePlaybackAudioMode();
        await sound.playAsync();
        manuallyPausedRef.current = false;
        setIsManuallyPaused(false);
      } catch (error) {
        console.log(`[听书恢复] 播放键续播失败，按最近字位重建：${error.message || error}`);
        manuallyPausedRef.current = false;
        setIsManuallyPaused(false);
        await restartNarrationFromCurrent('播放键续播失败');
      }
    } else {
      if (!sound) {
        if (phase === 'playing') await restartNarrationFromCurrent('播放键兜底重建sound');
        return;
      }
      try {
        await sound.pauseAsync();
      } catch (error) {
        console.log(`[听书恢复] 暂停失败，释放失效sound等待下次重建：${error.message || error}`);
        epochRef.current += 1;
        await stopSound();
      }
      manuallyPausedRef.current = true;
      setIsManuallyPaused(true);
      flushListenProgress('暂停', true);
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
    const epoch = ++epochRef.current;
    posRef.current = { chapterIdx, paragraphIdx: targetPi };
    paragraphProgressRef.current = { chapterIdx, paragraphIdx: targetPi, charOffset: 0 };
    flushListenProgress('拖动进度', true);
    (async () => {
      await stopSound();
      if (epoch === epochRef.current) playFrom(chapterIdx, targetPi, epoch);
    })();
  }

  // 章节选择弹层点了某一章——从这一章开头重新播，跟"从0段开始"的老逻辑
  // 一致（chaptersRef是扁平的宏观章节列表，idx就是数组下标）。
  function handleJumpToChapter(idx) {
    if (idx < 0 || idx >= chaptersRef.current.length) return;
    const epoch = ++epochRef.current;
    posRef.current = { chapterIdx: idx, paragraphIdx: 0 };
    paragraphProgressRef.current = { chapterIdx: idx, paragraphIdx: 0, charOffset: 0 };
    flushListenProgress('切换章节', true);
    setChapterTitle(chaptersRef.current[idx].title);
    setPhase('loading-chapter');
    setShowChapterPicker(false);
    (async () => {
      await stopSound();
      if (epoch === epochRef.current) playFrom(idx, 0, epoch);
    })();
  }

  async function handleStepNarration(direction) {
    if (phase !== 'playing' && phase !== 'loading-chapter') return;
    const chapters = chaptersRef.current;
    const current = posRef.current;
    const currentChapter = chapters[current.chapterIdx];
    if (!currentChapter) return;
    const epoch = ++epochRef.current;
    setPhase('loading-chapter');
    await stopSound();
    try {
      let currentParagraphs = paragraphCacheRef.current[currentChapter.id];
      if (!currentParagraphs) {
        currentParagraphs = await loadNarrationParagraphs(currentChapter);
        paragraphCacheRef.current[currentChapter.id] = currentParagraphs;
      }
      let adjacentParagraphCount = 0;
      if (direction < 0 && current.paragraphIdx === 0 && current.chapterIdx > 0) {
        const previousChapter = chapters[current.chapterIdx - 1];
        let previousParagraphs = paragraphCacheRef.current[previousChapter.id];
        if (!previousParagraphs) {
          previousParagraphs = await loadNarrationParagraphs(previousChapter);
          paragraphCacheRef.current[previousChapter.id] = previousParagraphs;
        }
        adjacentParagraphCount = previousParagraphs.length;
      }
      if (epoch !== epochRef.current) return;
      const target = resolveNarrationStep({
        chapterIdx: current.chapterIdx,
        paragraphIdx: current.paragraphIdx,
        direction,
        chapterCount: chapters.length,
        currentParagraphCount: currentParagraphs.length,
        adjacentParagraphCount,
      });
      if (!target) {
        setPhase('playing');
        playFrom(current.chapterIdx, current.paragraphIdx, epoch);
        return;
      }
      posRef.current = target;
      paragraphProgressRef.current = { ...target, charOffset: 0 };
      flushListenProgress(direction > 0 ? '下一朗读段' : '上一朗读段', true);
      setChapterTitle(chapters[target.chapterIdx]?.title || '');
      playFrom(target.chapterIdx, target.paragraphIdx, epoch);
    } catch (error) {
      if (epoch !== epochRef.current) return;
      console.log(`[听书诊断] 按段跳转失败：${error.message || error}`);
      setErrorMsg(error.message || '朗读位置切换失败');
      setPhase('error');
    }
  }

  // 用户点小播放键确认后才跳转；轻触正文只由selectCaptionCandidate选择候选。
  // 整章字幕的
  // sentenceIndex是"当前章节全文"语境下的全局句子下标（见buildCaptionContext
  // 把chunks拼成整章文本那次改动），要先换算回playFrom认识的
  // {chapterIdx, paragraphIdx, charOffset}——复用resolveJumpTarget这个纯
  // 函数，再原样照抄handleStepNarration"停止当前播放→改posRef/
  // paragraphProgressRef→保存进度→playFrom"这一套已经验证过的流程，不
  // 自己另写一套；playFrom本身完全没有改动。
  function handleJumpToSentence(sentenceIndex) {
    if (phase !== 'playing' && phase !== 'loading-chapter') return;
    const chapters = chaptersRef.current;
    const current = posRef.current;
    const currentChapter = chapters[current.chapterIdx];
    const paragraphs = currentChapter ? paragraphCacheRef.current[currentChapter.id] : null;
    if (!currentChapter || !paragraphs) return; // 字幕能显示出来，说明这份分块理应已经缓存过
    const sentences = splitCaptionSentences(currentCaption);
    const sentence = sentences[sentenceIndex];
    if (!sentence) return;
    const target = resolveJumpTarget({
      chunkLengths: paragraphs.map((p) => p.length),
      chapterIdx: current.chapterIdx,
      charOffset: sentence.start,
    });
    if (!target) return;
    candidateSentenceIndexRef.current = null;
    setCandidateSentenceIndex(null);
    captionForceRealignRef.current = true;
    const epoch = ++epochRef.current;
    // 跳转是"从当前正在播的地方直接切走"，不像上一段/下一段那样需要先转
    // loading-chapter态等资源——目标段落已经在缓存里，phase保持playing，
    // 用户体感更像"拖进度条"而不是"切章节"。
    stopSound().then(() => {
      if (epoch !== epochRef.current) return;
      posRef.current = target;
      paragraphProgressRef.current = target;
      flushListenProgress('点句跳转', true);
      // 恢复自动跟随：用户这次点击就是"我选好位置了"，接下来应该跟着新
      // 位置的朗读自动滚动，不需要再等4秒弹回倒计时。
      captionUserScrollingRef.current = false;
      clearCaptionIdleTimer();
      clearCaptionMomentumWait();
      clearCaptionMomentumSafety();
      playFrom(target.chapterIdx, target.paragraphIdx, epoch);
    });
  }

  async function stopHandsFreeReplySound() {
    const sound = hfReplySoundRef.current;
    hfReplySoundRef.current = null;
    if (!sound) return;
    try { sound.setOnPlaybackStatusUpdate(null); } catch (_) {}
    await sound.stopAsync().catch(() => {});
    await sound.unloadAsync().catch(() => {});
  }

  function toggleHandsFreeReplyMute() {
    const next = !hfReplyMutedRef.current;
    hfReplyMutedRef.current = next;
    setHfReplyMuted(next);
    const sound = hfReplySoundRef.current;
    if (!sound) return;
    if (next) sound.pauseAsync().catch(() => {});
    else sound.playAsync().catch(() => {});
  }

  // 环境监听时metering回调判定"开始说话"之后调用的入口——停掉环境监听那路
  // 录音（内容不要，只是刚才拿来测音量），马上开一路全新的录音正式捕捉
  // 这句话，全程留在朗读字幕视图（phase不变，不跳转），跟手动"打断"那套
  // 聊天气泡流程完全独立。
  function startHandsFreeTurn(forceMic = false) {
    const interruptingReply = hfActiveRef.current && hfStage === 'replying';
    if (phase !== 'playing' && !interruptingReply) return;
    if (handsFreeMuted && !forceMic) return;
    if (hfActiveRef.current && !interruptingReply) return;
    if (!interruptingReply) flushListenProgress('免提打断', true);
    if (interruptingReply) {
      finishHfTiming('AI回复被用户长按打断');
      hfAbortRef.current?.();
      hfAbortRef.current = null;
      hfReplyInterruptingRef.current = true;
    }
    hfActiveRef.current = true;
    epochRef.current += 1;
    startHfTiming(interruptingReply ? 'AI回复中二次打断' : '正文朗读中免提打断');
    // 先给触摸反馈，再做 Android 上可能较慢的 stop/unload 与录音模式切换。
    setHfStage('listening');
    (async () => {
      await stopSound();
      await stopHandsFreeReplySound();
      await stopHandsFreeAmbient(); // 等它真的放开麦克风，再开正式录音那一路，两路录音先后而不是同时存在
      markHfTiming('打断音频并释放环境监听');
      await hfListenTurnLoop({ skipIntent: forceMic });
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
    let recordingStarted = false;
    let pendingRecording = null;
    try {
      markHfTiming('准备正式录音');
      const { status: perm } = await Audio.requestPermissionsAsync();
      setHfTimingMeta({ microphonePermission: perm });
      if (perm !== 'granted') {
        markHfTiming(`麦克风权限未授予 status=${perm}`);
        setVoiceMicError('麦克风权限未开启，请在系统设置中允许 ChatBook 使用麦克风');
        return null;
      }
      if (!voiceHoldActiveRef.current) {
        markHfTiming('权限检查后手指已松开，跳过录音');
        return null;
      }
      await enableRecordingAudioMode();
      const recording = new Audio.Recording();
      pendingRecording = recording;
      const manualHoldMode = MANUAL_HOLD_TO_TALK;
      let speechEverDetected = false;
      let silenceMs = 0;
      let elapsedMs = 0;
      let settled = false;
      let finishReason = '';
      let recordingStartedAt = 0;
      const donePromise = new Promise((resolve) => {
        hfListenResolveRef.current = (reason = 'external') => {
          if (settled) return;
          settled = true;
          finishReason = reason;
          resolve();
        };
      });
      recording.setProgressUpdateInterval(HF_METER_INTERVAL_MS);
      recording.setOnRecordingStatusUpdate((status) => {
        if (!status.isRecording) return;
        elapsedMs += HF_METER_INTERVAL_MS;
        const db = typeof status.metering === 'number' ? status.metering : -160;
        // dBFS 映射为 0～1，只驱动现有麦克风按钮的光晕，不参与端点判断，
        // 因而灯效不会反过来改变录音何时开始/结束。
        // 真机反馈：光晕一闪一闪、有点卡——原来每次metering回调都直接
        // setValue，配合下面micGlowStyle之前跟"变色"那个必须走JS线程的动画
        // 混在一起(Animated.multiply)，导致整个光晕每120ms都要在JS线程
        // 重算一次。改成用短时长的Animated.timing(useNativeDriver:true)包一下，
        // 既能让这个值真正注册进原生动画驱动、后续更新交给原生线程处理，
        // 又顺带让音量变化之间的过渡更平滑，不是生硬地跳变。
        Animated.timing(micLevelProgress, {
          toValue: Math.max(0, Math.min(1, (db + 55) / 43)),
          duration: HF_METER_INTERVAL_MS,
          useNativeDriver: true,
        }).start();
        if (db >= HF_SPEECH_DB) {
          speechEverDetected = true;
          silenceMs = 0;
        } else {
          silenceMs += HF_METER_INTERVAL_MS;
        }
        const shouldStop = manualHoldMode
          ? elapsedMs >= HF_MANUAL_HOLD_MAX_MS
          : (speechEverDetected && silenceMs >= HF_SILENCE_END_MS)
            || (!speechEverDetected && elapsedMs >= HF_NO_SPEECH_TIMEOUT_MS)
            || elapsedMs >= HF_MAX_UTTERANCE_MS;
        if (shouldStop) {
          const reason = manualHoldMode
            ? 'manual_max_duration'
            : elapsedMs >= HF_MAX_UTTERANCE_MS
              ? 'vad_max_duration'
              : speechEverDetected
                ? 'vad_silence'
                : 'vad_no_speech';
          hfListenResolveRef.current?.(reason);
        }
      });
      await recording.prepareToRecordAsync({ ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true });
      await recording.startAsync();
      recordingStarted = true;
      pendingRecording = null;
      recordingStartedAt = Date.now();
      markHfTiming('正式录音已开始', 'recording_started');
      console.log(`[免提诊断] 正式录音开始 mode=${manualHoldMode ? 'manual_hold' : 'vad'} hold=${voiceHoldActiveRef.current}`);
      hfRecordingRef.current = recording;
      if (MANUAL_HOLD_TO_TALK && !voiceHoldActiveRef.current) {
        setTimeout(() => { hfListenResolveRef.current?.('manual_released_before_start'); }, 0);
      }
      // 双保险：万一某些机型metering回调不触发/触发不及时，硬性上限兜底，
      // 不会无限录下去。
      hfListenTimerRef.current = setTimeout(() => {
        hfListenResolveRef.current?.(manualHoldMode ? 'manual_timer_max' : 'timer_max');
      }, (manualHoldMode ? HF_MANUAL_HOLD_MAX_MS : HF_MAX_UTTERANCE_MS) + 1500);
      await donePromise;
      voiceHoldActiveRef.current = false;
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
      const wallElapsedMs = recordingStartedAt ? Date.now() - recordingStartedAt : elapsedMs;
      setHfTimingMeta({ recordingStopReason: finishReason || 'unknown', recordingMode: manualHoldMode ? 'manual_hold' : 'vad', recordingElapsedMs: wallElapsedMs });
      markHfTiming(`录音结束 reason=${finishReason || 'unknown'} mode=${manualHoldMode ? 'manual_hold' : 'vad'} speech=${speechEverDetected} elapsed=${wallElapsedMs}ms`, 'endpoint_end');
      console.log(`[免提诊断] 录音结束 reason=${finishReason || 'unknown'} mode=${manualHoldMode ? 'manual_hold' : 'vad'} speech=${speechEverDetected} meterElapsed=${elapsedMs}ms wallElapsed=${wallElapsedMs}ms`);
      const uri = rec.getURI();
      await restorePlaybackAudioMode();
      if (!manualHoldMode && !speechEverDetected) return null; // 自动监听全程没检测到声音，不浪费一次识别请求
      if (manualHoldMode && wallElapsedMs < HF_MANUAL_HOLD_MIN_MS) {
        markHfTiming(`手动长按过短，跳过ASR elapsed=${wallElapsedMs}ms`);
        return null;
      }
      markHfTiming('开始ASR识别', 'asr_start');
      setHfStage('transcribing');
      const text = await transcribeAudio(
        uri,
        FileSystem.uploadAsync,
        FileSystem.FileSystemUploadType,
        (timings) => setHfTimingMeta({
          asrServerTranscodeMs: timings.transcode_ms,
          asrProviderMs: timings.provider_ms,
        }),
      );
      markHfTiming(`ASR识别完成 chars=${(text || '').trim().length}`, 'asr_end');
      setHfTimingMeta({ asrTextChars: (text || '').trim().length });
      return (text || '').trim();
    } catch (e) {
      markHfTiming(`录音/ASR失败 ${e.message || e}`);
      setHfTimingMeta({ recordingError: String(e.message || e), recordingStarted });
      setVoiceMicError(recordingStarted ? '语音识别失败，请再试一次' : `麦克风启动失败：${e.message || e}`);
      await pendingRecording?.stopAndUnloadAsync().catch(() => {});
      await restorePlaybackAudioMode().catch(() => {});
      return null;
    } finally {
      micLevelProgress.setValue(0);
    }
  }

  // 录一次+决定接下来怎么办：免提触发之后"听问题"、和AI回答完之后"听
  // 追问/继续"，都是同一套判断逻辑，抽出来共用，不用再为两个场景分别写
  // 一遍。识别到"继续"类指令或者压根没识别出内容——恢复朗读；识别出内容
  // 但AI判断这不是真的在向它提问（多半是环境噪音/电视声/别人说话被误
  // 识别）——用户明确要求"不相关就继续读"，同样恢复朗读，不弹出回答去
  // 打扰；只有真的是在提问，才进入askHandsFree真正去问AI。
  async function hfListenTurnLoop({ skipIntent = false } = {}) {
    const text = await hfRecordUntilSilence();
    if (!hfActiveRef.current) return;
    markHfTiming(text ? `识别文本进入判断 chars=${text.length}` : '没有有效识别文本');
    if (!text || isContinueVoiceCommand(text)) {
      markHfTiming('判定为继续正文');
      finishHandsFreeTurn();
      return;
    }
    setHfStage(expectsExternalSearch(text) ? 'searching' : 'thinking');
    const chapter = chaptersRef.current[posRef.current.chapterIdx];
    let relevant = true;
    if (skipIntent) {
      setHfTimingMeta({ skippedIntent: true });
      markHfTiming('手动长按：跳过意图分类');
    } else {
      try {
        markHfTiming('开始意图分类', 'intent_start');
        relevant = await classifyIntent(text, bookTitle, chapter?.title || '');
        markHfTiming(`意图分类完成 relevant=${relevant}`, 'intent_end');
      } catch (e) {
        markHfTiming(`意图分类失败 ${e.message || e}`);
        relevant = true; // 判断这一步本身失败，保守当成是提问，交给下面真正的问答逻辑处理
      }
    }
    if (!hfActiveRef.current) return;
    if (!relevant && !looksLikeHandsFreeQuestion(text)) {
      markHfTiming('判定为无关内容，恢复正文');
      finishHandsFreeTurn();
      return;
    }
    const messageId = ++voiceMessageIdRef.current;
    setVoiceMessages((prev) => [...prev, { id: messageId, role: 'user', content: text }]);
    setConversationExpanded(true);
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
    hfReplyMutedRef.current = false;
    setHfReplyMuted(false);
    markHfTiming(`开始AI问答 questionChars=${question.length}`);
    setHfTimingMeta({ questionChars: question.length });
    const chapter = chaptersRef.current[posRef.current.chapterIdx];
    let replyWasInterrupted = false;
    let sawFirstDelta = false;
    const epoch = epochRef.current;
    let fullAnswer = '';
    let sentenceBuffer = '';
    let streamDone = false;
    let playing = false;
    let preparing = false;
    let prepared = null;
    let markedPlayEnd = false;
    let firstTtsQueued = false;
    let replyClosing = false;
    let seq = 0;
    const replyId = ++voiceMessageIdRef.current;
    const queue = [];

    await new Promise((resolve) => {
      const maybeResolve = () => {
        if (!streamDone || playing || preparing || prepared || queue.length > 0) return;
        if (!markedPlayEnd && fullAnswer.trim()) {
          markedPlayEnd = true;
          markHfTiming('AI回复播放结束', 'answer_play_end');
          snapshotHfTiming();
        }
        resolve();
      };

      const prefetchNext = async () => {
        if (replyClosing || prepared || preparing || queue.length === 0) return;
        const item = queue.shift();
        preparing = true;
        try {
          const { sound } = await Audio.Sound.createAsync(
            { uri: getTtsPlayUrl(item.text, voiceRef.current, rateRef.current) },
            { shouldPlay: false },
          );
          if (replyClosing || epoch !== epochRef.current || !hfActiveRef.current) {
            sound.unloadAsync().catch(() => {});
            return;
          }
          prepared = { ...item, sound };
        } catch (e) {
          markHfTiming(`AI回复TTS预取失败 ${e.message || e}`);
        } finally {
          preparing = false;
          maybeResolve();
        }
      };

      const playNext = async () => {
        if (replyClosing || playing) return;
        if (epoch !== epochRef.current || !hfActiveRef.current) {
          maybeResolve();
          return;
        }
        let item = null;
        if (prepared) {
          item = prepared;
          prepared = null;
        } else if (queue.length > 0) {
          item = queue.shift();
        } else {
          maybeResolve();
          return;
        }
        playing = true;
        if (item.seq === 1) markHfTiming('首段TTS切换播放音频模式', 'first_tts_audio_mode_start');
        await restorePlaybackAudioMode().catch(() => {});
        if (item.seq === 1) markHfTiming('首段TTS播放音频模式就绪', 'first_tts_audio_mode_end');
        let sound = item.sound;
        if (!sound) {
          try {
            if (item.seq === 1) markHfTiming('首段TTS开始加载', 'first_tts_load_start');
            ({ sound } = await Audio.Sound.createAsync(
              { uri: getTtsPlayUrl(item.text, voiceRef.current, rateRef.current) },
              { shouldPlay: false },
            ));
            if (item.seq === 1) markHfTiming('首段TTS加载完成', 'first_tts_load_end');
          } catch (e) {
            playing = false;
            markHfTiming(`AI回复TTS加载失败 ${e.message || e}`);
            playNext();
            return;
          }
          if (epoch !== epochRef.current || !hfActiveRef.current) {
            sound.unloadAsync().catch(() => {});
            playing = false;
            maybeResolve();
            return;
          }
        }
        hfReplySoundRef.current = sound;
        sound.setOnPlaybackStatusUpdate((s) => {
          // !isLoaded 不等于自然播放完成：它也可能是音频对象切换期间的
          // 瞬时状态或真正的加载错误。此前把两者合并处理，会提前 unload
          // 当前回答；iOS 真机表现就是在第一处句间停顿附近停止并恢复正文。
          if (!s.isLoaded) {
            if (s.error) {
              markHfTiming(`AI回复播放状态错误 ${s.error}`);
              sound.unloadAsync().catch(() => {});
              if (hfReplySoundRef.current === sound) hfReplySoundRef.current = null;
              playing = false;
              playNext();
            }
            return;
          }
          if (item.seq === 1 && s.isPlaying && !hfTimingRef.current?.marks?.answer_audio_start) {
            markHfTiming('AI回复TTS实际开始播放', 'answer_audio_start');
          }
          if (s.didJustFinish) {
            sound.unloadAsync().catch(() => {});
            if (hfReplySoundRef.current === sound) hfReplySoundRef.current = null;
            playing = false;
            playNext();
          }
        });
        if (item.seq === 1) markHfTiming('首段TTS请求播放', 'first_tts_play_request');
        const beginReplyPlayback = () => sound.playAsync().then(() => {
          if (!hfTimingRef.current?.marks?.answer_audio_start) {
            markHfTiming('AI回复TTS开始播放', 'answer_audio_start');
            if (handsFreeEnabled && !handsFreeMuted && !MANUAL_HOLD_TO_TALK) {
              setHandsFreeStatus('AI回复中也在监听');
              startHandsFreeAmbient()
                .then(() => markHfTiming('AI回复期间环境监听已开启'))
                .catch((e) => markHfTiming(`AI回复期间环境监听启动失败 ${e.message || e}`));
            }
          }
        }).catch((e) => {
          markHfTiming(`AI回复播放失败 ${e.message || e}`);
          playing = false;
          playNext();
        });
        if (!hfReplyMutedRef.current) beginReplyPlayback();
        prefetchNext();
      };

      const enqueueReplyTts = (text) => {
        const clean = stripCitationMarkersForSpeech(text);
        if (!clean) return;
        if (!firstTtsQueued) {
          firstTtsQueued = true;
          markHfTiming('首段回答TTS入队', 'first_tts_enqueue');
        }
        const firstStop = clean.search(/[。！？；]/);
        markHfTiming(
          `AI回复TTS入队 chars=${clean.length} charsAfterFirstStop=${firstStop >= 0 ? clean.length - firstStop - 1 : 0}`,
        );
        queue.push({ seq: ++seq, text: clean });
        if (playing) prefetchNext();
        else playNext();
      };

      const flushSentences = (isFinal) => {
        if (!HF_REPLY_TTS_STREAMING_ENABLED) {
          if (isFinal && fullAnswer.trim()) {
            enqueueReplyTts(fullAnswer);
            sentenceBuffer = '';
          }
          return;
        }
        let pending = '';
        for (;;) {
          const idx = sentenceBuffer.search(NARRATION_SENTENCE_END);
          if (idx === -1) break;
          pending += sentenceBuffer.slice(0, idx + 1);
          sentenceBuffer = sentenceBuffer.slice(idx + 1);
          if (pending.length >= HF_REPLY_MIN_TTS_CHUNK_LEN) {
            enqueueReplyTts(pending);
            pending = '';
          }
        }
        if (pending) sentenceBuffer = pending + sentenceBuffer;
        if (isFinal && sentenceBuffer.trim()) {
          enqueueReplyTts(sentenceBuffer);
          sentenceBuffer = '';
        }
      };

      markHfTiming('LLM请求开始', 'llm_start');
      const heardContext = buildHeardChapterContext(
        paragraphCacheRef.current[chapter?.id] || [],
        posRef.current.paragraphIdx,
      );
      hfAbortRef.current = streamAsk(
        {
          context: {
            bookTitle, author, chapterTitle: chapter?.title || '',
            selection: heardContext || currentCaption, pageText: '',
            userHighlights: [], popularHighlights: [],
          },
          question,
          style: 'voice',
          history: [...promptHistoryRef.current],
        },
        {
          onDelta: (delta) => {
            if (epoch !== epochRef.current || !hfActiveRef.current) return;
            if (!sawFirstDelta) {
              sawFirstDelta = true;
              markHfTiming('LLM首个增量返回', 'llm_first_delta');
            }
            fullAnswer += delta;
            sentenceBuffer += delta;
            setHfStage('replying');
            setVoiceMessages((prev) => prev.some((msg) => msg.id === replyId)
              ? prev.map((msg) => msg.id === replyId ? { ...msg, content: fullAnswer } : msg)
              : [...prev, { id: replyId, role: 'assistant', content: fullAnswer }]);
            if (HF_REPLY_TTS_STREAMING_ENABLED) flushSentences(false);
          },
          onDone: async (answer, _evidenceType, externalSources) => {
            hfAbortRef.current = null;
            if (epoch !== epochRef.current || !hfActiveRef.current) {
              streamDone = true;
              maybeResolve();
              return;
            }
            const finalAnswer = answer || fullAnswer;
            const streamedAnswer = fullAnswer;
            if (finalAnswer && finalAnswer !== fullAnswer) {
              fullAnswer = finalAnswer;
            }
            if (finalAnswer) {
              setVoiceMessages((prev) => prev.some((msg) => msg.id === replyId)
                ? prev.map((msg) => msg.id === replyId ? { ...msg, content: finalAnswer, sources: externalSources || [] } : msg)
                : [...prev, { id: replyId, role: 'assistant', content: finalAnswer, sources: externalSources || [] }]);
            }
            markHfTiming(`AI回复完成 answerChars=${finalAnswer.length}`, 'llm_done');
            setHfTimingMeta({ answerChars: finalAnswer.length });
            rememberPromptTurn(question, finalAnswer);
            const fakeCfi = `listen:${chapter?.id}:${posRef.current.paragraphIdx}`;
            saveQaHistory({
              bookId, bookTitle, chapterTitle: chapter?.title || '',
              question, answer: finalAnswer, selection: currentCaption, cfiRange: fakeCfi, style: 'simple',
              sessionId: listenSessionIdRef.current, modality: 'listen',
            }).catch(() => {});
            if (finalAnswer && finalAnswer !== streamedAnswer) {
              if (finalAnswer.startsWith(streamedAnswer)) {
                sentenceBuffer += finalAnswer.slice(streamedAnswer.length);
              } else {
                sentenceBuffer = finalAnswer;
              }
              fullAnswer = finalAnswer;
            }
            flushSentences(true);
            streamDone = true;
            maybeResolve();
          },
          onError: async () => {
            hfAbortRef.current = null;
            markHfTiming('AI问答失败');
            replyClosing = true;
            streamDone = true;
            queue.length = 0;
            const unusedPrepared = prepared;
            prepared = null;
            if (unusedPrepared?.sound) {
              try { unusedPrepared.sound.setOnPlaybackStatusUpdate(null); } catch (_) {}
              await unusedPrepared.sound.stopAsync().catch(() => {});
              await unusedPrepared.sound.unloadAsync().catch(() => {});
            }
            await stopHandsFreeReplySound();
            playing = false;
            resolve();
          },
        },
      );
    });
    replyWasInterrupted = epoch !== epochRef.current || hfReplyInterruptingRef.current;
    if (!replyWasInterrupted) {
      await stopHandsFreeAmbient();
    }
    await stopHandsFreeReplySound();
    if (!hfActiveRef.current) return;
    if (replyWasInterrupted) return;
    if (MANUAL_HOLD_TO_TALK) {
      markHfTiming('手动按住说话：回答结束后关闭麦克风并恢复正文');
      finishHandsFreeTurn();
      return;
    }
    setHfStage('listening');
    await hfListenTurnLoop();
  }

  // 免提这一轮结束（不管是没听到问题、判断不相关、用户说继续、还是问答
  // 播完的追问窗口安静下来）——恢复朗读，并且如果免提总开关还开着、没被
  // 静音，重新开一路环境监听录音接回。
  function finishHandsFreeTurn() {
    if (!hfActiveRef.current) return;
    hfActiveRef.current = false;
    hfReplyInterruptingRef.current = false;
    setHfStage('');
    setConversationExpanded(false);
    const { chapterIdx, paragraphIdx } = posRef.current;
    epochRef.current += 1;
    hfResumePendingRef.current = true;
    markHfTiming(`恢复正文 chapter=${chapterIdx} paragraph=${paragraphIdx}`, 'resume_start');
    const epoch = epochRef.current;
    (async () => {
      await stopSound();
      await stopHandsFreeReplySound();
      await restorePlaybackAudioMode().catch(() => {});
      playFrom(chapterIdx, paragraphIdx, epoch);
    })();
    if (handsFreeEnabled && !handsFreeMuted && !MANUAL_HOLD_TO_TALK) {
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
    stopHandsFreeReplySound();
    const rec = hfRecordingRef.current;
    hfRecordingRef.current = null;
    if (rec) {
      rec.stopAndUnloadAsync().catch(() => {});
      restorePlaybackAudioMode().catch(() => {});
    }
    setHfStage('');
  }

  function handleVoiceModeMicGestureStart() {
    if (MANUAL_HOLD_TO_TALK) {
      if (hfStage && hfStage !== 'replying') return;
      setVoiceMicError('');
      voiceHoldActiveRef.current = true;
      console.log(`[免提诊断] mic gestureStart stage=${hfStage || 'idle'} muted=${handsFreeMuted} phase=${phase}`);
      if (hfStage === 'replying') {
        setHandsFreeMuted(false);
        startHandsFreeTurn(true);
        return;
      }
      if (handsFreeMuted) {
        setHandsFreeMuted(false);
        startHandsFreeTurn(true);
      }
      return;
    }
    setHandsFreeMuted((v) => !v);
  }

  function handleVoiceModeMicGestureEnd(reason = 'manual_release') {
    if (!MANUAL_HOLD_TO_TALK) return;
    if (!voiceHoldActiveRef.current && hfStage !== 'listening') return;
    voiceHoldActiveRef.current = false;
    console.log(`[免提诊断] mic gestureEnd reason=${reason} stage=${hfStage || 'idle'} resolve=${!!hfListenResolveRef.current}`);
    setHandsFreeMuted(true);
    setHfStage('transcribing');
    setConversationExpanded(true);
    hfListenResolveRef.current?.(reason);
  }

  micGestureHandlersRef.current = {
    grant: handleVoiceModeMicGestureStart,
    release: () => handleVoiceModeMicGestureEnd('manual_release'),
    cancel: () => handleVoiceModeMicGestureEnd('manual_cancelled'),
  };
  const micHoldGesture = useMemo(() => Gesture.LongPress()
    .minDuration(180)
    .maxDistance(1000)
    .shouldCancelWhenOutside(false)
    .runOnJS(true)
    .onStart(() => micGestureHandlersRef.current.grant?.())
    .onEnd((_event, success) => {
      if (success) micGestureHandlersRef.current.release?.();
      else micGestureHandlersRef.current.cancel?.();
    })
    .onFinalize((_event, success) => {
      if (!success) micGestureHandlersRef.current.cancel?.();
    }), []);

  drawerGestureHandlersRef.current = {
    expand: () => setConversationExpanded(true),
    collapse: () => setConversationExpanded(false),
    toggle: () => setConversationExpanded((value) => !value),
  };
  const conversationDrawerGesture = useMemo(() => Gesture.Exclusive(
    Gesture.Pan()
      .activeOffsetY([-10, 10])
      .runOnJS(true)
      .onEnd((event) => {
        if (event.translationY < -24) drawerGestureHandlersRef.current.expand?.();
        if (event.translationY > 24) drawerGestureHandlersRef.current.collapse?.();
      }),
    Gesture.Tap()
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success) drawerGestureHandlersRef.current.toggle?.();
      }),
  ), []);

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
          selection: capturedHeardContextRef.current || capturedText, pageText: '',
          userHighlights: [], popularHighlights: [],
        },
        question: q,
        style: 'simple',
        history: [...promptHistoryRef.current],
      },
      {
        onDelta: (delta) => { fullAnswer += delta; },
        onDone: async (answer, _evidenceType, externalSources) => {
          abortAskRef.current = null;
          setConversation((prev) => [...prev, { role: 'assistant', content: answer, sources: externalSources || [] }]);
          rememberPromptTurn(q, answer);
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
            sessionId: listenSessionIdRef.current, modality: 'listen',
          }).catch(() => {});
          setPhase('answering');
          const epoch = epochRef.current;
          try {
            await playOneParagraph(stripCitationMarkersForSpeech(answer), epoch);
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
        restorePlaybackAudioMode().catch(() => {});
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
    if (handsFreeEnabled && !handsFreeMuted && !MANUAL_HOLD_TO_TALK && !hfAmbientRecordingRef.current) {
      setHandsFreeStatus('免提监听中');
      startHandsFreeAmbient();
    }
  }

  async function handleStopListening() {
    await flushListenProgress('退出听书', true);
    epochRef.current += 1;
    await stopSound();
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
      await restorePlaybackAudioMode();
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
      await enableRecordingAudioMode();
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
      await enableRecordingAudioMode();
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
    const db = status.metering;
    const now = Date.now();
    const floor = hfAmbientNoiseFloorRef.current;
    const triggerDb = Math.max(HF_SPEECH_DB, floor + HF_SPEECH_NOISE_MARGIN_DB);
    const cooldownActive = now - hfLastTriggerAtRef.current < HF_TRIGGER_COOLDOWN_MS;
    if (db < triggerDb) {
      // 环境底噪用慢速均值估计，只在没触发时更新。这样空调/路噪这类
      // 持续背景声会抬高门槛，但用户真正开口时不会马上把门槛也抬上去。
      hfAmbientNoiseFloorRef.current = floor * 0.94 + db * 0.06;
    }
    if (!cooldownActive && db >= triggerDb) {
      hfAmbientSustainCountRef.current += 1;
      hfAmbientPeakDbRef.current = Math.max(hfAmbientPeakDbRef.current, db);
      if (!hfAmbientSpeakingRef.current
          && hfAmbientSustainCountRef.current * HF_METER_INTERVAL_MS >= HF_SPEECH_SUSTAIN_MS
          && hfAmbientPeakDbRef.current >= HF_SPEECH_MIN_PEAK_DB) {
        hfAmbientSpeakingRef.current = true;
        hfLastTriggerAtRef.current = now;
        console.log(`[免提诊断] 环境监听触发 db=${db.toFixed(1)} peak=${hfAmbientPeakDbRef.current.toFixed(1)} floor=${floor.toFixed(1)} trigger=${triggerDb.toFixed(1)}`);
        autoInterruptRef.current?.();
      }
    } else {
      hfAmbientSustainCountRef.current = 0;
      hfAmbientPeakDbRef.current = -160;
      hfAmbientSpeakingRef.current = false;
    }
  }

  // 开启免提总开关——起一路expo-av录音专门用来测环境音量（内容不要）。
  // 不再依赖react-native-webrtc/react-native-incall-manager，expo-av是
  // 标准Expo SDK的一部分，不需要开发版本/dev client就能跑，Expo Go里
  // 也应该能用（跟手动打断那条录音路径用的是同一个底层能力）。
  async function startHandsFreeAmbient() {
    try {
      if (MANUAL_HOLD_TO_TALK) {
        const { status: perm } = await Audio.getPermissionsAsync();
        if (perm === 'denied') {
          setVoiceMicError('麦克风权限未开启，请在系统设置中允许 ChatBook 使用麦克风');
        }
        await restorePlaybackAudioMode().catch(() => {});
        setHandsFreeStatus('按住麦克风说话');
        return;
      }
      const { status: perm } = await Audio.requestPermissionsAsync();
      if (perm !== 'granted') {
        setHandsFreeStatus('麦克风权限被拒绝，免提打断无法开启');
        setHandsFreeEnabled(false);
        return;
      }
      await enableRecordingAudioMode();
      const recording = new Audio.Recording();
      hfAmbientSustainCountRef.current = 0;
      hfAmbientSpeakingRef.current = false;
      hfAmbientPeakDbRef.current = -160;
      hfAmbientNoiseFloorRef.current = -60;
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
      setHandsFreeStatus(MANUAL_HOLD_TO_TALK ? '按住麦克风说话' : '连接中…');
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
  const manualHoldToTalkEnabled = handsFreeEnabled && MANUAL_HOLD_TO_TALK;
  const manualAskLabel = !manualHoldToTalkEnabled
    ? '打断，我想问问'
    : hfStage === 'replying'
      ? '打断追问'
      : hfStage === 'listening'
        ? '正在听你说'
        : hfStage === 'transcribing'
          ? '正在转写…'
          : hfStage === 'searching'
            ? '正在联网查证…'
            : hfStage === 'thinking'
              ? '正在思考…'
              : '开始提问';
  const voiceModeStatus = (!hfStage && voiceMicError) ? voiceMicError : hfStage
    ? (hfStage === 'listening'
      ? '已锁定当前句 · 松开发送'
      : hfStage === 'transcribing'
        ? '正在把语音转成文字…'
        : hfStage === 'searching'
          ? '正在联网查证…'
          : hfStage === 'thinking'
            ? '正在理解问题…'
            : '正在组织回答…')
    : handsFreeMuted
      ? (MANUAL_HOLD_TO_TALK ? '按住左下角麦克风随时提问' : '已静音 · 继续讲书')
      : MANUAL_HOLD_TO_TALK
        ? '松开后发送问题'
        : '正在听 · 你可以直接说话';
  const transportControls = (
    <View style={styles.transport}>
      <View style={styles.transportSlot}>
        <TouchableOpacity
          style={styles.transportIconBtn}
          onPress={() => handleStepNarration(-1)}
          accessibilityLabel="上一朗读段"
        >
          <IconPlayerTrackPrevFilled color={EMBER.paperDim} size={18} />
        </TouchableOpacity>
      </View>
      <View style={styles.transportSlot}>
        <TouchableOpacity
          style={styles.transportPlayBtn}
          onPress={togglePlayPause}
          disabled={phase !== 'playing'}
          accessibilityLabel={isManuallyPaused ? '继续播放' : '暂停播放'}
        >
          {isManuallyPaused
            ? <IconPlayerPlayFilled color={EMBER.emberBright} size={20} />
            : <IconPlayerPauseFilled color={EMBER.emberBright} size={20} />}
        </TouchableOpacity>
      </View>
      <View style={styles.transportSlot}>
        <TouchableOpacity
          style={styles.transportIconBtn}
          onPress={() => handleStepNarration(1)}
          accessibilityLabel="下一朗读段"
        >
          <IconPlayerTrackNextFilled color={EMBER.paperDim} size={18} />
        </TouchableOpacity>
      </View>
    </View>
  );
  const captionSentenceCount = captionSentences.length;
  const drawerClosedOffset = Math.max(0, (mainStageHeight || 800) * 0.66 - 42);
  const drawerTranslateY = conversationDrawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [drawerClosedOffset, 0],
  });
  const readingTranslateY = conversationDrawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, mainStageHeight * -0.16],
  });
  const micVisualStyle = {
    backgroundColor: micVisualProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [EMBER.dusk, EMBER.emberBright],
    }),
    transform: [{
      scale: micVisualProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] }),
    }],
  };
  // 之前用Animated.multiply把这个值跟micVisualProgress(必须走JS线程，因为
  // 它还驱动着背景色变化)混在一起算透明度，导致光晕这个纯opacity/scale、
  // 本可以走原生动画驱动的效果被一起拖慢。现在只用micLevelProgress自己算，
  // 显示/隐藏改成在下面JSX里按hfStage直接条件渲染这个View，不再靠"乘以0"
  // 去隐藏。
  const micGlowStyle = {
    opacity: micLevelProgress.interpolate({ inputRange: [0, 1], outputRange: [0.14, 0.72] }),
    transform: [{
      scale: micLevelProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.42] }),
    }],
  };

  return (
    <View style={styles.stage}>
      <ListenAtmosphere />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.safe}>
        <View style={[styles.bar, { paddingTop: insets.top + 14 }]}>
          <TouchableOpacity onPress={handleStopListening} style={styles.iconBtn}>
            <IconChevronLeft color={EMBER.paperDim} size={20} strokeWidth={2} />
          </TouchableOpacity>
          <View style={styles.crumb}>
            <Text style={styles.bookTitleText} numberOfLines={1}>{bookTitle}</Text>
            <Text style={styles.chapCrumbText} numberOfLines={1}>{chapterTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
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
              <View
                style={[styles.mainStage, handsFreeEnabled && styles.mainStageVoiceMode]}
                onLayout={({ nativeEvent }) => setMainStageHeight(nativeEvent.layout.height)}
              >
                {inNarrating ? (
                  <>
                    {conversationExpanded && (
                      <TouchableOpacity
                        style={styles.conversationDismissLayer}
                        activeOpacity={1}
                        onPress={() => setConversationExpanded(false)}
                        accessibilityLabel="收起对话记录"
                      />
                    )}
                    <Animated.View
                      onLayout={({ nativeEvent }) => {
                        // captionZone用absoluteFillObject铺满mainStage，高度只取决于
                        // 父容器，不依赖FlatList自己的内容——用这里测量代替原来"FlatList
                        // 自己的onLayout反过来决定它的Header/Footer占位高度"的循环依赖，
                        // 真机上那个循环依赖会导致列表刚挂载时Header高度从0跳变到定值，
                        // 内容跟着重排，首句所在行的ref因此反复挂载/卸载数秒，期间自动
                        // 居中全部失效(校正后测量失败：节点未挂载)。padding上28下48是
                        // captionZone自身的固定内边距，减去后就是FlatList实际可用高度。
                        const height = Math.max(0, nativeEvent.layout.height - 28 - 48);
                        if (Math.abs(height - captionViewportHeightRef.current) < 1) return;
                        captionViewportHeightRef.current = height;
                        setCaptionViewportHeight(height);
                      }}
                      style={[
                      styles.captionZone,
                      handsFreeEnabled ? styles.captionZoneVoiceMode : styles.captionZoneReading,
                      {
                        opacity: conversationDrawerProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.42] }),
                        transform: [{ translateY: readingTranslateY }],
                      },
                    ]}>
                      {phase === 'loading-chapter' ? (
                        <ActivityIndicator color={EMBER.emberBright} />
                      ) : (
                        <>
                          <FlatList
                          ref={captionScrollRef}
                          data={captionSentences}
                          keyExtractor={(item, index) => `${item.start}-${item.end}-${index}`}
                          renderItem={({ item, index }) => (
                            <NarrationSentenceRow
                              sentence={item}
                              index={index}
                              activeIndex={captionSentenceIndex}
                              candidateIndex={candidateSentenceIndex}
                              rowRef={(node) => {
                                if (node) captionSentenceNodesRef.current[index] = node;
                                else delete captionSentenceNodesRef.current[index];
                              }}
                              onConfirm={handleJumpToSentence}
                            />
                          )}
                          extraData={`${captionSentenceIndex}:${candidateSentenceIndex ?? 'none'}`}
                          style={styles.captionScroll}
                          contentContainerStyle={styles.captionScrollContent}
                          ListHeaderComponent={<View style={{ height: Math.max(0, captionViewportHeight / 2 - 20) }} />}
                          ListFooterComponent={(
                            <View>
                              {captionSentenceCount > 0 && (
                                <Text style={styles.captionCountText}>
                                  本章 · 第 {Math.min(captionSentenceIndex + 1, captionSentenceCount)} / {captionSentenceCount} 句
                                </Text>
                              )}
                              <View style={{ height: Math.max(0, captionViewportHeight / 2 - 20) }} />
                            </View>
                          )}
                          onLayout={() => {
                            followCaptionSentence(captionSentenceIndexRef.current, false);
                          }}
                          onScrollBeginDrag={handleCaptionScrollBeginDrag}
                          onScrollEndDrag={handleCaptionScrollEndDrag}
                          onMomentumScrollBegin={handleCaptionMomentumScrollBegin}
                          onMomentumScrollEnd={handleCaptionMomentumScrollEnd}
                          onViewableItemsChanged={handleCaptionViewableItemsChanged}
                          viewabilityConfig={captionViewabilityConfig}
                          onScrollToIndexFailed={handleCaptionScrollToIndexFailed}
                          initialNumToRender={24}
                          maxToRenderPerBatch={24}
                          windowSize={9}
                          removeClippedSubviews={false}
                        />
                        </>
                      )}
                      {phase !== 'loading-chapter' && (
                        <Text style={styles.captionVoiceStatus}>{voiceModeStatus}</Text>
                      )}
                    </Animated.View>
                    <Animated.View style={[
                      styles.voiceConversationArea,
                      { transform: [{ translateY: drawerTranslateY }] },
                    ]}>
                      <GestureDetector gesture={conversationDrawerGesture}>
                        <View
                          style={styles.conversationHandle}
                          accessible
                          accessibilityRole="button"
                          accessibilityLabel={`${conversationExpanded ? '收起' : '展开'}对话记录，共${voiceMessages.length}条`}
                        >
                          <View style={styles.conversationHandleMark} />
                          <Text style={styles.conversationHandleText}>对话记录{voiceMessages.length ? ` · ${voiceMessages.length}` : ''}</Text>
                        </View>
                      </GestureDetector>
                      {conversationDrawerMounted && (
                        <>
                          {voiceMessages.length > 0 ? (
                          <ScrollView
                            ref={voiceConversationRef}
                            style={styles.voiceConversationScroll}
                            contentContainerStyle={styles.voiceConversationContent}
                            onContentSizeChange={() => {
                              if (voiceAutoScrollRef.current) voiceConversationRef.current?.scrollToEnd({ animated: false });
                            }}
                            onScrollBeginDrag={() => { voiceAutoScrollRef.current = false; }}
                            onScrollEndDrag={({ nativeEvent }) => {
                              const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
                              voiceAutoScrollRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
                            }}
                            onMomentumScrollEnd={({ nativeEvent }) => {
                              const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
                              voiceAutoScrollRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
                            }}
                          >
                            <Text style={styles.conversationDrawerTitle}>本次对话与最近历史</Text>
                            {voiceMessages.map((msg) => (
                              <View
                                key={msg.id}
                                style={[styles.conversationMessage, msg.role === 'user' ? styles.conversationMessageUser : styles.conversationMessageAi]}
                              >
                                <Text style={styles.conversationSpeaker}>
                                  {msg.role === 'user' ? '我' : 'AI'}{msg.historical ? ' · 历史' : ''}
                                </Text>
                                <View style={[styles.bubble, msg.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}>
                                  {msg.role === 'user' ? (
                                    <Text style={styles.bubbleUserText}>{msg.content}</Text>
                                  ) : (
                                    <>
                                      <ListenAnswerText text={msg.content} sources={msg.sources} style={styles.bubbleAiText} />
                                      <ListenSourcesRow sources={msg.sources} />
                                    </>
                                  )}
                                </View>
                              </View>
                            ))}
                          </ScrollView>
                          ) : (
                            <View style={styles.conversationEmpty}>
                              <Text style={styles.voiceStageText}>还没有对话</Text>
                            </View>
                          )}
                          {!!hfStage && (
                            <View style={styles.voiceStageRow}>
                              {['transcribing', 'searching', 'thinking'].includes(hfStage) && (
                                <ActivityIndicator size="small" color={EMBER.emberBright} />
                              )}
                              <Text style={styles.voiceStageText}>
                                {hfStage === 'listening'
                                  ? '正在聆听…'
                                  : hfStage === 'transcribing'
                                    ? '正在转写你的问题…'
                                    : hfStage === 'searching'
                                      ? '正在联网查证…'
                                      : hfStage === 'thinking'
                                        ? '正在理解问题…'
                                        : '正在组织回答…'}
                              </Text>
                              {hfStage === 'replying' && (
                                <TouchableOpacity
                                  style={styles.replyMuteButton}
                                  onPress={toggleHandsFreeReplyMute}
                                  accessibilityRole="button"
                                  accessibilityLabel={hfReplyMuted ? '继续朗读AI回答' : '暂停朗读AI回答'}
                                >
                                  {hfReplyMuted
                                    ? <IconVolumeOff color={EMBER.emberBright} size={16} strokeWidth={2} />
                                    : <IconVolume color={EMBER.paperDim} size={16} strokeWidth={2} />}
                                </TouchableOpacity>
                              )}
                            </View>
                          )}
                        </>
                      )}
                    </Animated.View>
                  </>
                ) : (
                  <ScrollView contentContainerStyle={styles.chatBody}>
                    <View style={styles.contextChip}>
                      <Text style={styles.contextChipLbl}>你打断时正讲到</Text>
                      <Text style={styles.contextChipText}>{capturedText}</Text>
                    </View>

                    {conversation.some((message) => message.historical) && (
                      <Text style={styles.conversationDrawerTitle}>最近听书问答</Text>
                    )}
                    {conversation.map((msg, idx) => (
                      <View
                        key={idx}
                        style={[styles.bubble, msg.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}
                      >
                        {msg.role === 'user' ? (
                          <Text style={styles.bubbleUserText}>{msg.content}</Text>
                        ) : (
                          <>
                            <ListenAnswerText text={msg.content} sources={msg.sources} style={styles.bubbleAiText} />
                            <ListenSourcesRow sources={msg.sources} />
                          </>
                        )}
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
              <View style={[styles.controls, handsFreeEnabled && styles.controlsVoiceMode]}>
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
                    <Text style={styles.progressTimeText}>{Math.round(segFraction * 100)}%</Text>
                  </View>
                </View>

                {inNarrating ? (
                  <>
                    <View style={styles.controlDock}>
                      <View style={styles.micControlSlot}>
                        <GestureDetector gesture={micHoldGesture}>
                          <Animated.View
                            style={[
                              styles.voiceModeRoundBtn,
                              hfStage === 'listening' ? styles.voiceModeMicBtnActive : styles.voiceModeMicBtnMuted,
                              micVisualStyle,
                            ]}
                            accessible
                            accessibilityRole="button"
                            accessibilityLabel={manualAskLabel}
                          >
                            {hfStage === 'listening' && (
                              <Animated.View pointerEvents="none" style={[styles.voiceModeMicGlow, micGlowStyle]} />
                            )}
                            <IconMicrophone
                              color={hfStage === 'listening' ? EMBER.ink : EMBER.inkSoft}
                              size={24}
                              strokeWidth={2.2}
                            />
                          </Animated.View>
                        </GestureDetector>
                      </View>
                      {transportControls}
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.conversationTransport}>{transportControls}</View>
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

                {!!handsFreeStatus && !handsFreeEnabled && inNarrating && (
                  <Text style={styles.micLabelText}>{handsFreeStatus}</Text>
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
    paddingHorizontal: 14, paddingBottom: 8,
  },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  crumb: { flex: 1, alignItems: 'center' },
  bookTitleText: { fontSize: 15, color: EMBER.paper, fontWeight: '500', fontFamily: FONTS.serifRegular },
  chapCrumbText: { fontSize: 11, color: EMBER.paperDim, marginTop: 4 },

  quickSettings: {
    flexDirection: 'row', alignSelf: 'center', justifyContent: 'center',
    height: 35, paddingHorizontal: 4,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(239,237,232,0.1)',
  },
  settingChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 11, paddingVertical: 7, maxWidth: 124,
  },
  settingChipText: { fontSize: 11, color: EMBER.paperDim },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorText: { fontSize: 14, textAlign: 'center', color: EMBER.paperDim },
  doneText: { fontSize: 17, color: EMBER.paper, fontWeight: '600' },

  mainStage: { flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' },
  mainStageVoiceMode: { justifyContent: 'center' },
  captionZone: {
    ...StyleSheet.absoluteFillObject,
    paddingTop: 28, paddingRight: 31, paddingBottom: 48, paddingLeft: 46,
    alignItems: 'stretch', justifyContent: 'center', zIndex: 1,
  },
  captionZoneReading: {},
  captionZoneVoiceMode: {},
  captionScroll: { flex: 1, alignSelf: 'stretch' },
  captionScrollContent: {
    flexGrow: 1, alignItems: 'stretch', justifyContent: 'flex-start', position: 'relative',
  },
  // 完整句子作为FlatList原生列表项，scrollToIndex可跨平台稳定定位。
  captionSentenceRow: {
    width: '100%', flexDirection: 'row', alignItems: 'center', minHeight: 32,
    borderRadius: 10, paddingHorizontal: 8, marginHorizontal: -8,
  },
  captionSentenceRowCandidate: {
    backgroundColor: 'rgba(239,237,232,0.07)',
  },
  captionSentenceText: { flex: 1 },
  captionParagraphText: {
    fontSize: 17, lineHeight: 32.3, textAlign: 'left', color: EMBER.paper,
    fontFamily: FONTS.serifRegular,
  },
  captionJumpButtonSlot: {
    width: 34, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: 2,
  },
  captionJumpButton: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(239,237,232,0.16)', borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(239,237,232,0.3)', elevation: 4,
  },
  captionCountText: { fontSize: 11, color: EMBER.paperDim, marginTop: 17, alignSelf: 'flex-start' },
  captionVoiceStatus: {
    position: 'absolute', left: 0, right: 0, bottom: 7,
    fontSize: 11, color: EMBER.paperDim, textAlign: 'center',
  },
  conversationDismissLayer: {
    ...StyleSheet.absoluteFillObject, zIndex: 2, backgroundColor: 'rgba(0,0,0,0.08)',
  },
  voiceConversationArea: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: '66%', zIndex: 4,
    backgroundColor: EMBER.ink,
    borderTopWidth: 0.5, borderTopColor: 'rgba(239,237,232,0.1)',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 21,
    shadowOffset: { width: 0, height: -9 }, elevation: 16,
  },
  conversationHandle: {
    height: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  conversationHandleMark: { width: 28, height: 3, borderRadius: 1.5, backgroundColor: EMBER.inkSoft },
  conversationHandleText: { fontSize: 11, color: EMBER.inkSoft },
  conversationEmpty: { flex: 1, minHeight: 80, alignItems: 'center', justifyContent: 'center' },
  voiceConversationScroll: { flex: 1 },
  voiceConversationContent: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 24, gap: 15 },
  conversationDrawerTitle: { marginBottom: 1, fontSize: 11, color: EMBER.paperDim },
  conversationMessage: { width: '100%' },
  conversationMessageUser: { alignItems: 'flex-end' },
  conversationMessageAi: { alignItems: 'flex-start' },
  conversationSpeaker: { marginBottom: 5, fontSize: 10, color: EMBER.paperDim },
  voiceStageRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  voiceStageText: { fontSize: 12, color: EMBER.inkSoft },
  replyMuteButton: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(239,237,232,0.18)',
    backgroundColor: EMBER.dusk2,
  },

  chatBody: { flexGrow: 1, padding: 16, gap: 14 },
  contextChip: {
    backgroundColor: 'rgba(226,150,58,0.08)', borderLeftWidth: 2, borderLeftColor: EMBER.emberDim,
    borderRadius: 4, padding: 10,
  },
  contextChipLbl: { fontSize: 10, color: EMBER.ember, marginBottom: 4, textTransform: 'uppercase' },
  contextChipText: { fontSize: 12.5, lineHeight: 19, color: EMBER.paperDim },
  bubble: { paddingHorizontal: 11, paddingVertical: 9, borderRadius: 6, maxWidth: '87%' },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#ebe8e1' },
  bubbleAi: {
    alignSelf: 'flex-start', backgroundColor: EMBER.dusk,
  },
  bubbleUserText: { fontSize: 13, lineHeight: 20.8, color: '#202123' },
  bubbleAiText: { fontSize: 13, lineHeight: 20.8, color: EMBER.paper },
  listenCitationMark: { color: EMBER.emberBright, fontWeight: '700', textDecorationLine: 'underline' },
  listenSourcesWrap: { marginTop: 8, alignSelf: 'stretch' },
  listenSourcesToggle: { paddingVertical: 4 },
  listenSourcesToggleText: { fontSize: 11, color: EMBER.emberBright },
  listenSourceItem: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 5, gap: 6 },
  listenSourceIndex: { width: 24, fontSize: 11, color: EMBER.emberBright },
  listenSourceBody: { flex: 1, minWidth: 0 },
  listenSourceTitle: { fontSize: 11.5, lineHeight: 16, color: EMBER.paper },
  listenSourceUrl: { marginTop: 1, fontSize: 9.5, lineHeight: 13, color: EMBER.paperDim },
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

  controls: {
    minHeight: 118, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14, gap: 5,
    backgroundColor: EMBER.ink,
    borderTopWidth: 0.5, borderTopColor: 'rgba(239,237,232,0.1)',
  },
  controlsVoiceMode: { paddingBottom: 14 },
  progress: { gap: 2 },
  progressSlider: { width: '100%', height: 22 },
  progressTimes: { flexDirection: 'row', justifyContent: 'space-between' },
  progressTimeText: { fontSize: 10.5, color: EMBER.inkSoft, letterSpacing: 0.3, maxWidth: '55%' },

  controlDock: { flexDirection: 'row', alignItems: 'center', minHeight: 58 },
  conversationTransport: { alignItems: 'center', paddingVertical: 2 },
  micControlSlot: { width: '25%', alignItems: 'center', justifyContent: 'center' },
  transport: { width: '75%', flexDirection: 'row', alignItems: 'center' },
  transportSlot: { width: '33.3333%', alignItems: 'center', justifyContent: 'center' },
  transportIconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  transportPlayBtn: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: EMBER.dusk,
    alignItems: 'center', justifyContent: 'center',
  },

  voiceModeRoundBtn: {
    width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center',
  },
  voiceModeMicGlow: {
    position: 'absolute', width: 66, height: 66, borderRadius: 33,
    backgroundColor: EMBER.emberBright,
  },
  voiceModeMicBtnActive: {
    backgroundColor: EMBER.emberBright,
    transform: [{ scale: 0.94 }],
    shadowColor: EMBER.emberBright, shadowOpacity: 0.22, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  voiceModeMicBtnMuted: {
    backgroundColor: EMBER.dusk,
  },
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
