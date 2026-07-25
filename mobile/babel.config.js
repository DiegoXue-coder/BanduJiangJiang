// 阶段十新增：@gorhom/bottom-sheet 依赖 react-native-reanimated，这个库
// 要求装一个 babel 插件才能工作（且必须放在 plugins 数组最后一项，
// 这是官方文档写死的要求，顺序错了会在真机上报运行时错误而不是编译期报错，
// 不好排查，照着官方顺序写）。项目原来没有 babel.config.js，全靠
// babel-preset-expo 默认配置，这次是第一次需要自定义插件。
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
