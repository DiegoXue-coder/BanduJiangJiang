// 阶段十一：全局字体替换。字体文件来自 Google Fonts 官方仓库
// （google/fonts，OFL开源协议）的 Noto Serif/Sans SC 可变字体，用
// fonttools 实例化出 Regular/Bold 两个静态字重（RN对可变字体的字重轴
// 支持不稳定，静态字重文件在各平台上更可靠）。
// Noto Serif/Sans SC 与 Adobe 发布的思源宋体/黑体是同一套字形数据、
// 同一个 OFL 协议下的姊妹产物（Adobe+Google联合开发），视觉效果一致。
//
// 阶段十九：阅读器字体选择器新增第三档"楷体"——霞鹜文楷/LXGW WenKai，
// 官方仓库 github.com/lxgw/LxgwWenKai，同样是OFL开源协议、免费商用，
// Kindle等电子书阅读场景口碑验证过的楷体字体。只加了Regular这一个字重
// （24.4MB，比思源宋黑体单字重的10~15MB更大，因为这款字体字形覆盖范围
// 更全）——决策层明确要求"这次只加这一种验证效果，不要一次性加更多"，
// 没有配套加Bold字重。
export const FONTS = {
  serifRegular: 'SourceHanSerifSC-Regular',
  serifBold: 'SourceHanSerifSC-Bold',
  sansRegular: 'SourceHanSansSC-Regular',
  sansBold: 'SourceHanSansSC-Bold',
  kaiRegular: 'LXGWWenKai-Regular',
};

export const FONT_ASSETS = {
  [FONTS.serifRegular]: require('./assets/fonts/SourceHanSerifSC-Regular.ttf'),
  [FONTS.serifBold]: require('./assets/fonts/SourceHanSerifSC-Bold.ttf'),
  [FONTS.sansRegular]: require('./assets/fonts/SourceHanSansSC-Regular.ttf'),
  [FONTS.sansBold]: require('./assets/fonts/SourceHanSansSC-Bold.ttf'),
  [FONTS.kaiRegular]: require('./assets/fonts/LXGWWenKai-Regular.ttf'),
};
