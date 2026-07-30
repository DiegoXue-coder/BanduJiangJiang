// 阶段十新增：@gorhom/bottom-sheet 依赖 react-native-reanimated，这个库
// 要求装一个 babel 插件才能工作（且必须放在 plugins 数组最后一项，
// 这是官方文档写死的要求，顺序错了会在真机上报运行时错误而不是编译期报错，
// 不好排查，照着官方顺序写）。项目原来没有 babel.config.js，全靠
// babel-preset-expo 默认配置，这次是第一次需要自定义插件。
// 2026-07-30修订：react-native-reanimated升到4.x之后，worklet编译相关的
// 功能被拆分进独立的react-native-worklets包（package.json里已经单独装了
// 这个包），插件路径也跟着改成了react-native-worklets/plugin——这一行
// 当时是照Reanimated 3.x时代的写法写的，升级4.x之后没人回头改，导致简单
// worklet（比如静态漂浮动效）还能凑合跑，但知识图谱这次新写的更复杂的
// worklet（手势回调里调用其他worklet函数、useDerivedValue链式传递）编译
// 不对，真机一拖拽就崩成黑屏——这是真机反复黑屏问题排查到现在，找到的
// 第一个直接对应真实文档记录的已知问题，不是又一次猜测。
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
