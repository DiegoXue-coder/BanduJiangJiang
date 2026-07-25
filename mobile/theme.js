// 阶段十：统一主题系统（"暖纸古风·护眼调整版"，决策层定稿）。
//
// 之前每个 screen 文件自己写死一份颜色常量（BLUE/AMBER/RED各写各的），
// 这次视觉规范要求全局统一配色+支持暗色模式，散落各处没法一次改全，
// 集中成这一个文件，所有screen改成从这里取token。
//
// 亮色模式5个核心token（背景/强调色/卡片/文字/强调色上的文字）是决策层
// 给的定稿数值，直接照抄；暗色模式的背景/卡片/强调色/文字4个也是定稿
// 数值，但规范原文明确写了"未经用户逐项过目，工程师实现时可以微调"。
// 除了这些核心token之外，实际界面还需要一些规范没直接给出的扩展token
// （次要文字色、错误色、划线/问答两种tag的区分色等）——这些是在给定的
// 暖棕色调范围内自行推导的，不是决策层规范的一部分，以后如果视觉这边
// 觉得不对可以只改这个文件，不用满仓库找颜色值。
import { useColorScheme } from 'react-native';

const light = {
  mode: 'light',
  bg: '#EAE3D3',
  cardBg: '#F5F1E7',
  cardBorder: '#D6CBB3',
  text: '#3D3226',
  textSecondary: '#8A7A63',
  textMuted: '#B3A78F',
  textOnAccent: '#F3EADD',
  accent: '#8C5642',
  accentSoft: '#E4D4C4',
  tag: '#A8823D',
  tagSoft: '#F0E4C8',
  danger: '#B5473A',
  dangerSoft: '#F3DCD7',
  shadowColor: '#000',
  radius: 4,
};

const dark = {
  mode: 'dark',
  bg: '#2A241E',
  cardBg: '#332B22',
  cardBorder: '#4A3F32',
  text: '#E3D5BE',
  textSecondary: '#B5A88F',
  textMuted: '#8A7E6A',
  textOnAccent: '#F3EADD',
  accent: '#9C6B52',
  accentSoft: '#453A2E',
  tag: '#C0A15C',
  tagSoft: '#413723',
  danger: '#C97363',
  dangerSoft: '#3E2A24',
  shadowColor: '#000',
  radius: 4,
};

export function useTheme() {
  const scheme = useColorScheme();
  return scheme === 'dark' ? dark : light;
}

export { light, dark };
