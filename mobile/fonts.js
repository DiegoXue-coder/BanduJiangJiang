// 阶段十一：全局字体替换。字体文件来自 Google Fonts 官方仓库
// （google/fonts，OFL开源协议）的 Noto Serif/Sans SC 可变字体，用
// fonttools 实例化出 Regular/Bold 两个静态字重（RN对可变字体的字重轴
// 支持不稳定，静态字重文件在各平台上更可靠）。
// Noto Serif/Sans SC 与 Adobe 发布的思源宋体/黑体是同一套字形数据、
// 同一个 OFL 协议下的姊妹产物（Adobe+Google联合开发），视觉效果一致。
export const FONTS = {
  serifRegular: 'SourceHanSerifSC-Regular',
  serifBold: 'SourceHanSerifSC-Bold',
  sansRegular: 'SourceHanSansSC-Regular',
  sansBold: 'SourceHanSansSC-Bold',
};

export const FONT_ASSETS = {
  [FONTS.serifRegular]: require('./assets/fonts/SourceHanSerifSC-Regular.ttf'),
  [FONTS.serifBold]: require('./assets/fonts/SourceHanSerifSC-Bold.ttf'),
  [FONTS.sansRegular]: require('./assets/fonts/SourceHanSansSC-Regular.ttf'),
  [FONTS.sansBold]: require('./assets/fonts/SourceHanSansSC-Bold.ttf'),
};
