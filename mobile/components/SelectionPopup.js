// 选中文字后的"浮动小菜单"：在选中的那几个字旁边弹出一个小小的、半透明的浮层（划线 / 问AI），
// 取代原来贴在屏幕最底下的一整条选字栏（那条栏又大又亮，盖住底部信息条，用户嫌杂乱）。
//
// 位置：默认在选中文字**上方**，水平对齐**第一行**选中的那几个字（贴屏幕边时夹在边距内）；上方放不下
// （选区太靠近屏幕顶部）就翻到**下方**，对齐**最后一行**选中的那几个字。
// 坐标来源：阅读页脚本在长按选字结束时量出选中文字的外接矩形（CSS 像素，相对页面视口），
// 这里按"页面视口宽 → 容器宽"的比例换算成容器里的位置。本组件必须放在"和阅读页同尺寸"的容器里
// （即 ReaderScreen 里 standardReader 那个 View 的子节点，铺满容器）。
//
// 外观：深色半透明的小圆角块，白字，中间一条细分隔线；浅色主题下用更深的半透明黑，
// 深色主题下用偏灰的半透明（否则在纯黑/深蓝底上看不出来），加一圈很淡的描边。
// 不用 elevation（安卓上 elevation 会参与层级排序，之前吃过"选字条被页面盖住"的亏），
// 层级用 zIndex 固定成很高的值。
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const GAP = 10; // 浮层和选区之间的距离
const EDGE = 8; // 浮层离容器边缘的最小距离

export default function SelectionPopup({ rect, rectEnd, vw, vh, dark, onHighlight, onAsk }) {
  const [box, setBox] = useState({ w: 0, h: 0 }); // 容器尺寸
  const [size, setSize] = useState({ w: 132, h: 36 }); // 浮层自己的尺寸（量出来之前先用估计值）
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 110, useNativeDriver: true }).start();
  }, [rect && rect.l, rect && rect.t]); // eslint-disable-line react-hooks/exhaustive-deps

  let left = 0;
  let top = 0;
  const ready = box.w > 0 && rect;
  if (ready) {
    const scale = box.w / (vw || box.w);
    // 默认摆在第一行选中文字的上方、水平对齐这几个字
    const first = { l: rect.l * scale, r: rect.r * scale, t: rect.t * scale };
    const last = rectEnd || rect;
    const lastR = { l: last.l * scale, r: last.r * scale, b: last.b * scale };
    left = (first.l + first.r) / 2 - size.w / 2;
    top = first.t - size.h - GAP;
    if (top < EDGE) {
      // 上方放不下：翻到最后一行选中文字的下方，水平改成对齐最后一行
      top = lastR.b + GAP;
      left = (lastR.l + lastR.r) / 2 - size.w / 2;
    }
    left = Math.max(EDGE, Math.min(box.w - size.w - EDGE, left));
    top = Math.max(EDGE, Math.min(box.h - size.h - EDGE, top));
  }

  return (
    <View
      style={styles.overlay}
      pointerEvents="box-none"
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {ready ? (
        <Animated.View
          onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          style={[
            styles.pop,
            dark ? styles.popDark : styles.popLight,
            { left, top, opacity: fade },
          ]}
        >
          <TouchableOpacity style={styles.btn} onPress={onHighlight} accessibilityLabel="划线">
            <Text style={styles.btnText}>划线</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.btn} onPress={onAsk} accessibilityLabel="问AI">
            <Text style={styles.btnText}>问AI</Text>
          </TouchableOpacity>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 2000000 },
  pop: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 2,
  },
  popLight: { backgroundColor: 'rgba(30,30,36,0.86)', borderColor: 'rgba(255,255,255,0.10)' },
  popDark: { backgroundColor: 'rgba(78,78,90,0.90)', borderColor: 'rgba(255,255,255,0.16)' },
  btn: { paddingHorizontal: 14, paddingVertical: 8 },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  divider: { width: StyleSheet.hairlineWidth, height: 16, backgroundColor: 'rgba(255,255,255,0.28)' },
});
