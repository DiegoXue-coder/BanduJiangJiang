// 阶段十九：统一主题系统换代——"暖纸古风"（阶段十定稿）已被决策层否掉，
// 换成"未来感/国际化"方向（深色精密网格+等宽字体数据标签+3D coverflow
// 书架），配色定档"雾灰蓝"这一档。数值直接抄自
// docs/设计稿/书架首页-未来感设计稿.html里`.phone[data-theme="fog"]`
// 那组CSS变量，不是凭"未来感""网格"这类文字描述自己发挥的。
//
// 设计稿本身只给了一组配色变量（--void/--paper/--paper-dim/--paper-faint/
// --gold/--teal这些），不是像阶段十那样直接对应本文件的token结构——
// 映射关系：--void→bg，--paper→text（这份设计稿里"paper"指的是深色
// 文字，不是背景，命名是从旧版沿用下来的，不要按字面意思理解成纸色
// 背景），--gold→accent（主强调色，书架里"公版经典库"分区用这个），
// --teal→tag（第二强调色，书架里"我的导入"分区用这个，语义上跟阶段十
// 划线/问答两种tag区分色的角色一致，所以复用tag这个token名而不是新增
// accent2，改动面更小）。
//
// accentSoft/tagSoft/danger/dangerSoft/cardBg/cardBorder这些设计稿没有
// 直接给出数值的扩展token，是在雾灰蓝这组给定色调范围内自行推导的浅色/
// 功能色变体，延续阶段十定下的"核心token照抄、扩展token自行推导"这个
// 分工方式，不是决策层规范的一部分——如果视觉上觉得不对，只用改这个
// 文件，不用满仓库找颜色值。
//
// 暗色模式用设计稿四档里最暗的"深空·柔化版"（data-theme="dusk"）当
// 对应的dark主题——决策层原文没有明确"暗色模式要不要一起换"，这是这次
// 实现时的判断，理由是这四档配色本来就是从亮到暗排的一组同源变体，
// dusk是其中最暗的一档，跟"暗色模式该有的样子"语义上对得上，比继续用
// 已经被否掉的暖纸古风暗色版更一致；如果决策层认为暗色模式不该动，
// 这里可以单独改回旧值，不影响亮色模式。
import { useColorScheme } from 'react-native';

const light = {
  mode: 'light',
  bg: '#CCD2D8',
  cardBg: '#E4E8EB',
  cardBorder: '#C3C9CF',
  text: '#161C26',
  textSecondary: '#525C68',
  textMuted: '#7C8794',
  textOnAccent: '#F3F5F6',
  accent: '#B4823A',
  accentSoft: '#E4D5B8',
  tag: '#2F7D76',
  tagSoft: '#CFE0DD',
  danger: '#B5473A',
  dangerSoft: '#F0DCD9',
  shadowColor: '#000',
  radius: 4,
};

const dark = {
  mode: 'dark',
  bg: '#1B212B',
  cardBg: '#232A35',
  cardBorder: '#333A45',
  text: '#EEF1F2',
  textSecondary: '#9098A3',
  textMuted: '#5F6772',
  textOnAccent: '#F3F5F6',
  accent: '#D4A24E',
  accentSoft: '#453A2A',
  tag: '#4FA6A0',
  tagSoft: '#25393C',
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
