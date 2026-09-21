// 外部分享导入（expo-share-intent）的"单点封装"，只在安卓加载，并且加载失败也不影响启动。
//
// 为什么要这样：expo-share-intent 会在被 import 的那一刻引入 expo-linking，而 expo-linking 的 JS 用的是
// `requireNativeModule('ExpoLinking')`——原生部分不存在就直接抛错。iOS TestFlight 安装包（1.0.0 构建 14，
// 2026-08-29 打的）里没有这个原生模块，9/7 加上分享导入之后，App.js 顶层的
// `import { ShareIntentProvider } from 'expo-share-intent'` 让 **iOS 上每一个新的 OTA 更新一启动就抛错**，
// expo-updates 的 ErrorRecovery 只好主动闪退一次、再退回安装包自带的旧版（用户在 iPhone 上看到
// "ChatBook crashed"，并且一直是旧界面——9/7 以后推给 iOS 的所有更新其实都没生效过）。
// 分享导入本来就只做了安卓（app.json 里 expo-share-intent 配了 disableIOS: true），所以：
// 非安卓平台根本不加载这个包；安卓上用 try/catch 包住 require，加载失败就当"没有分享导入"。
//
// 通用规则（以后新增带原生代码的依赖都适用）：TestFlight 包的原生部分是 8/29 定下来的，
// 之后新增的原生依赖，**任何静态 import 都可能让 iOS 的 OTA 在启动时崩溃**——要么只在安卓用、要么走
// lib/nativeCaps.js 这种"探测有原生模块才 require"的写法。
import React from 'react';
import { Platform } from 'react-native';

let impl = null;
if (Platform.OS === 'android') {
  try {
    // eslint-disable-next-line global-require
    impl = require('expo-share-intent');
  } catch (e) {
    console.warn('[shareIntent] expo-share-intent 不可用，外部分享导入关闭', e?.message || e);
    impl = null;
  }
}

const EMPTY_CONTEXT = {
  isReady: false,
  hasShareIntent: false,
  shareIntent: { files: null, text: null, webUrl: null, type: null },
  resetShareIntent: () => {},
  error: null,
};

export function ShareIntentProvider({ children }) {
  if (impl && impl.ShareIntentProvider) {
    const Provider = impl.ShareIntentProvider;
    return <Provider>{children}</Provider>;
  }
  return <>{children}</>;
}

export function useShareIntentContext() {
  // impl 在整个进程生命周期内不变，所以这里"有条件地调用 hook"是安全的
  return impl && impl.useShareIntentContext ? impl.useShareIntentContext() : EMPTY_CONTEXT;
}
