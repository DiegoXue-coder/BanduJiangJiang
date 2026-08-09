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
import Slider from '@react-native-community/slider';
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

export default function ListenScreen({ route, navigation }) {
  const { bookId, bookTitle, author, initialChapterTitle, startFraction } = route.params;
  const theme = useTheme();
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
  const [showSettings, setShowSettings] = useState(false);
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
          // 回答播完直接回到paused（输入框重新激活），不再经过单独的
          // "要继续追问还是继续听书"二次确认页——"继续听书"链接在对话线
          // 下方一直可点，"继续追问"就是接着在输入框里打字。
          if (epoch === epochRef.current) setPhase('paused');
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
    setConversation([]); // 回到听书主线，这一轮打断的对话线结束
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
    setIsTranscribing(true);
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
          <View style={styles.rateLabelRow}>
            <Text style={[styles.settingsLabel, { color: theme.textSecondary }]}>语速</Text>
            <Text style={[styles.rateValueText, { color: theme.text }]}>{rateDisplay.toFixed(2)}×</Text>
          </View>
          <Slider
            style={styles.rateSlider}
            minimumValue={RATE_MIN}
            maximumValue={RATE_MAX}
            step={RATE_STEP}
            value={rateStrToMultiplier(rate)}
            minimumTrackTintColor={theme.accent}
            maximumTrackTintColor={theme.cardBorder}
            thumbTintColor={theme.accent}
            onValueChange={setRateDisplay}
            onSlidingComplete={(v) => setRate(rateMultiplierToStr(v))}
          />
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

          {(phase === 'paused' || phase === 'thinking' || phase === 'answering') && (
            <ScrollView contentContainerStyle={styles.pausedContent}>
              <Text style={[styles.capturedLabel, { color: theme.textSecondary }]}>刚才讲到——</Text>
              <View style={[styles.capturedBox, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
                <Text style={[styles.capturedText, { color: theme.text }]}>{capturedText}</Text>
              </View>

              {/* 对话式UI：追问历史留在屏幕上持续展示，不再是问一次跳一次
                  页面。用户消息靠右、AI回答靠左，跟微信这类聊天界面的
                  阅读习惯保持一致。 */}
              {conversation.map((msg, idx) => (
                <View
                  key={idx}
                  style={[
                    styles.chatBubble,
                    { borderRadius: theme.radius },
                    msg.role === 'user'
                      ? [styles.chatBubbleUser, { backgroundColor: theme.accent }]
                      : [styles.chatBubbleAssistant, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderWidth: 1 }],
                  ]}
                >
                  <Text style={msg.role === 'user' ? { color: theme.textOnAccent } : { color: theme.text }}>
                    {msg.content}
                  </Text>
                </View>
              ))}

              {phase === 'thinking' && (
                <View style={styles.thinkingRow}>
                  <ActivityIndicator color={theme.accent} size="small" />
                  <Text style={[styles.thinkingText, { color: theme.textSecondary }]}>AI正在思考…</Text>
                </View>
              )}
              {phase === 'answering' && (
                <View style={styles.thinkingRow}>
                  <ActivityIndicator color={theme.accent} size="small" />
                  <Text style={[styles.thinkingText, { color: theme.textSecondary }]}>AI正在朗读回答…</Text>
                </View>
              )}

              {phase === 'paused' && (
                <>
                  <View style={styles.questionRow}>
                    {isTranscribing ? (
                      // 真机反馈：识别中的状态之前只在输入框下面一小行字提示，
                      // 容易被忽略、以为"卡住了"。改成直接顶替输入框本身的显示
                      // 内容，转圈+文字放在用户视线正对着的输入区域里，更显眼。
                      <View style={[styles.questionInput, styles.questionInputFlex, styles.transcribingBox, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, borderRadius: theme.radius }]}>
                        <ActivityIndicator size="small" color={theme.accent} />
                        <Text style={[styles.transcribingText, { color: theme.textSecondary }]}>正在识别语音…</Text>
                      </View>
                    ) : (
                      <TextInput
                        style={[styles.questionInput, styles.questionInputFlex, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder, color: theme.text, borderRadius: theme.radius }]}
                        placeholder={conversation.length ? '继续追问…' : '想问点什么？（比如"你刚才说的这个是什么意思"）'}
                        placeholderTextColor={theme.textMuted}
                        value={question}
                        onChangeText={setQuestion}
                        multiline
                      />
                    )}
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
                  {/* 识别中已经在上面输入框位置显示了动效，这里不重复显示，
                      避免两处同时出现"识别中"造成视觉上的冗余。 */}
                  {!!recordingStatus && !isTranscribing && (
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
                </>
              )}

              <TouchableOpacity style={styles.linkBtn} onPress={handleContinue}>
                <Text style={[styles.linkBtnText, { color: theme.textSecondary }]}>
                  {conversation.length ? '不问了，继续听书' : '不问了，接着听'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
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
  rateLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rateValueText: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  rateSlider: { width: '100%', height: 32 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13 },
  questionRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  questionInputFlex: { flex: 1 },
  transcribingBox: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  transcribingText: { fontSize: 14 },
  micBtn: { borderWidth: 1, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  recordingStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recordingStatus: { fontSize: 12 },
  saveHighlightRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  saveHighlightText: { fontSize: 13 },
  chatBubble: { padding: 12, maxWidth: '85%' },
  chatBubbleUser: { alignSelf: 'flex-end' },
  chatBubbleAssistant: { alignSelf: 'flex-start' },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  thinkingText: { fontSize: 13 },
});
