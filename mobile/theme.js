// 阶段十九：统一主题系统换代——"暖纸古风"（阶段十定稿）已被决策层否掉，
// 换成"未来感/国际化"方向（深色精密网格+等宽字体数据标签+3D coverflow
// 书架），配色定档"雾灰蓝"这一档。
//
// 续二十七（2026-08-13）更新：决策层出了真正的"定稿"交互原型
// （docs/设计稿/ChatBook可交互原型-定稿.html），取代了之前1号照着做的
// "书架首页-未来感设计稿.html"那版早期探索稿。配色方向本身没有变
// （还是雾灰蓝+金棕/青绿），但"定稿"里的实际CSS数值比旧稿更精确——
// 尤其是卡片背景色（旧稿书架卡片用的浅灰E4E8EB，定稿的--surface是纯白
// #ffffff）、暗色模式的--void/--surface（旧稿的1B212B/232A35比定稿的
// 12161D/1A2029明显浅一截）——这次改成完全对齐"定稿"文件里
// `.phone`/`.phone[data-mode="dark"]`那两组CSS变量的实际数值，不是
// 沿用旧稿数值。映射关系不变：--void→bg，--paper→text（这份设计稿里
// "paper"指深色文字，不是背景，命名沿用自更早的旧版，不要按字面理解成
// 纸色背景），--gold→accent，--teal→tag，新增--gold-dim/--gold-bright/
// --teal-dim三个设计稿明确给出但本文件之前没有的token，映射成
// accentDim/accentBright/tagDim；--surface-2映射成cardBg2（新token，
// 卡片内部再分层用，比如问AI面板里"引用原文"那块背景要比面板本身背景
// 深一点）。
//
// accentSoft/tagSoft/danger/dangerSoft这几个设计稿没有给出数值的扩展
// token，延续"核心token照抄设计稿、扩展token自行推导"的老规矩，不是
// 决策层规范的一部分。
//
// 续二十七新增护眼模式（eyecare）——"定稿"原型阅读器顶部有一个日间/
// 护眼/夜间循环切换的图标，README明确要求"复用theme.js已有light/dark
// 两套token机制，新增护眼作为第三套"，数值抄自定稿文件里
// `.phone[data-mode="eyecare"]`那组CSS变量。
import { useState, useEffect } from 'react';
import { useColorScheme } from 'react-native';

const light = {
  mode: 'light',
  bg: '#CCD2D8',
  cardBg: '#FFFFFF',
  cardBg2: '#F2F4F6',
  cardBorder: 'rgba(20,30,45,0.12)',
  text: '#161C26',
  textSecondary: '#525C68',
  textMuted: '#7C8794',
  textOnAccent: '#F3F5F6',
  accent: '#B4823A',
  accentDim: '#8A6428',
  accentBright: '#C99A4C',
  accentSoft: '#E4D5B8',
  tag: '#2F7D76',
  tagDim: '#1E5652',
  tagSoft: '#CFE0DD',
  danger: '#B5473A',
  dangerSoft: '#F0DCD9',
  shadowColor: '#000',
  radius: 4,
};

const dark = {
  mode: 'dark',
  bg: '#12161D',
  cardBg: '#1A2029',
  cardBg2: '#212936',
  cardBorder: 'rgba(255,255,255,0.09)',
  text: '#EEF1F4',
  textSecondary: '#A6B0BD',
  textMuted: '#68717D',
  textOnAccent: '#F3F5F6',
  accent: '#C99A4C',
  accentDim: '#E0B46A',
  accentBright: '#E6C284',
  accentSoft: '#453A2A',
  tag: '#4A9B93',
  tagDim: '#2F6961',
  tagSoft: '#25393C',
  danger: '#C97363',
  dangerSoft: '#3E2A24',
  shadowColor: '#000',
  radius: 4,
};

// 护眼模式：暖色低对比度，专门给长时间阅读场景降低蓝光刺激用，跟"夜间
// 模式"（纯粹为暗光环境不刺眼）目的不一样，不能互相替代——ReaderScreen.js
// 里已经有的THEMES.paper（EPUB正文背景色三态之一，标签就叫"护眼模式"）
// 是同一个语义概念，这次让全局chrome的护眼档跟正文的paper档保持视觉
// 呼应，不是各管各的两套颜色。
const eyecare = {
  mode: 'eyecare',
  bg: '#ECE3D0',
  cardBg: '#F6EFDD',
  cardBg2: '#EEE3CA',
  cardBorder: 'rgba(60,45,20,0.12)',
  text: '#4A3C26',
  textSecondary: '#7A6A4D',
  textMuted: '#9C8F74',
  textOnAccent: '#FBF7EE',
  accent: '#9A7233',
  accentDim: '#7D5A26',
  accentBright: '#B4823A',
  accentSoft: '#E8D9B8',
  tag: '#4D7A68',
  tagDim: '#345449',
  tagSoft: '#D7E3DD',
  danger: '#B5473A',
  dangerSoft: '#F0DCD9',
  shadowColor: '#000',
  radius: 4,
};

const THEMES_BY_MODE = { light, dark, eyecare };

// 全局主题手动覆盖——之前useTheme()纯跟随系统useColorScheme，没有用户
// 手动选择的能力。"定稿"原型的护眼模式是阅读器里一个图标点一下就循环
// 切换的手动控件，不是系统深色模式设置能带出来的第三态，必须有一个能
// 手动设置、且改动后全App所有用了useTheme()的地方都跟着重渲染的机制。
// 用模块级变量+订阅者集合这个轻量套路（跟lib/api.js里onAuthExpired的
// 广播机制是同一个思路），不用为了这一个需求把useTheme()从"随处可调的
// hook"改成"必须包在Provider里才能用"，改动面小很多——现在几乎每个
// screen文件都直接调useTheme()，不经过任何Context Provider。
let modeOverride = null; // null = 跟随系统深色模式设置；'light'|'dark'|'eyecare' = 用户手动选定，一直生效到下次手动改
const modeListeners = new Set();

export function setThemeMode(mode) {
  modeOverride = mode;
  modeListeners.forEach((fn) => fn(mode));
}

export function getThemeMode() {
  return modeOverride;
}

function subscribeThemeMode(fn) {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

export function useTheme() {
  const scheme = useColorScheme();
  const [override, setOverride] = useState(modeOverride);
  useEffect(() => subscribeThemeMode(setOverride), []);
  const mode = override || (scheme === 'dark' ? 'dark' : 'light');
  return THEMES_BY_MODE[mode] || light;
}

export { light, dark, eyecare };
