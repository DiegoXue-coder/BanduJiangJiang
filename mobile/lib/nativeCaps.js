// 新原生模块的"探测 + 单点封装"（沉浸式阅读器的电量、玻璃模糊）。
//
// 为什么需要它：expo-battery / expo-blur 是原生模块，OTA 只能更新 JS，不能给
// 已经装在用户手机上的旧安装包加原生代码。而这两个库在旧包上的表现是：
//   - expo-battery：import 时就会因找不到原生模块 `ExpoBattery` 直接抛错——ReaderScreen
//     被 App.js 静态引用，等于**整个 App 启动即崩**；
//   - expo-blur：import 不抛错，但首次渲染 <BlurView> 时会崩（找不到原生视图）。
// 所以本项目里**任何文件都不能直接 import 这两个包**，一律从这里取：先探测原生
// 能力是否真的存在，存在才 require，不存在就返回 null，由调用方降级
// （电量不显示；玻璃只用半透明底色）。
//
// 探测用的正是这两个库自己在内部查的注册表，不是另造一套判断：
//   - 模块：requireOptionalNativeModule('ExpoBattery')（找不到返回 null，不抛错）
//   - 视图：NativeModules.NativeUnimoduleProxy.viewManagersMetadata.ExpoBlurView
//     （expo-modules-core 的 requireNativeViewManager('ExpoBlurView') 查的同一处）
// 用运行时 require 而不是顶层 import，保证探测不通过时对应包的 JS 根本不会被执行。
import { NativeModules } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

let batteryModule; // undefined = 还没探测；null = 不可用
let blurViewComponent;

export function getBatteryModule() {
  if (batteryModule !== undefined) return batteryModule;
  batteryModule = null;
  try {
    if (requireOptionalNativeModule('ExpoBattery')) {
      // eslint-disable-next-line global-require
      batteryModule = require('expo-battery');
    }
  } catch (e) {
    console.warn('[nativeCaps] expo-battery 不可用，电量不显示', e?.message || e);
    batteryModule = null;
  }
  return batteryModule;
}

export function getBlurView() {
  if (blurViewComponent !== undefined) return blurViewComponent;
  blurViewComponent = null;
  try {
    const metadata = NativeModules?.NativeUnimoduleProxy?.viewManagersMetadata;
    if (metadata && metadata.ExpoBlurView) {
      // eslint-disable-next-line global-require
      blurViewComponent = require('expo-blur').BlurView || null;
    }
  } catch (e) {
    console.warn('[nativeCaps] expo-blur 不可用，玻璃仅用半透明底色', e?.message || e);
    blurViewComponent = null;
  }
  return blurViewComponent;
}
