import React, { useEffect, useState, useCallback } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { NavigationContainer, getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ReaderProvider } from '@epubjs-react-native/core';
import { IconBooks, IconHighlight, IconUserCircle } from '@tabler/icons-react-native';

import BookshelfScreen from './screens/BookshelfScreen';
import ReaderScreen from './screens/ReaderScreen';
import ReviewScreen from './screens/ReviewScreen';
import ReviewBookScreen from './screens/ReviewBookScreen';
import ReviewDetailScreen from './screens/ReviewDetailScreen';
import ProfileScreen from './screens/ProfileScreen';
import LoginScreen from './screens/LoginScreen';
import { useTheme } from './theme';
import { FONT_ASSETS } from './fonts';
import { loadStoredToken, isLoggedIn, onAuthExpired } from './lib/api';

// 阶段十一：底部tab从emoji换成Tabler Icons（MIT协议，免费商用）
const TAB_ICON_COMPONENT = { 书架: IconBooks, 划线复盘: IconHighlight, 我的: IconUserCircle };

// 全局字体替换——界面元素统一用思源黑体。原来这里想用 Text.defaultProps
// 设全局默认字体，试了才发现这条路走不通：RN 0.81 的 <Text> 已经是函数组件
// 不是class，React 19 对函数组件的 defaultProps 直接不生效了；就算生效，
// defaultProps 也只在完全不传 style 时才顶用，这个App里几乎每个Text都自己
// 传了style，起不到全局默认的效果。真正生效的改法是打了个patch直接改
// node_modules/react-native/Libraries/Text/Text.js（见
// patches/react-native+0.81.5.patch），在库内部处理完调用方自己的style后，
// 没设fontFamily才补上默认值——只有那一处能同时覆盖"全局默认"和"看到
// 显式指定就不覆盖"这两个要求。

const Tab = createBottomTabNavigator();
const BookshelfStack = createNativeStackNavigator();
const ReviewStack = createNativeStackNavigator();

// 书架tab自己的堆栈——点书本卡片会"推入"阅读器页面，阅读器时隐藏底部tab栏。
// 阶段十：BookChat 不再是独立页面，改成 ReaderScreen 内部用 BottomSheetModal
// 弹出的"问AI"面板（原文全程可见，不是跳转整页覆盖），这里不用再注册它。
function BookshelfStackScreen() {
  return (
    <BookshelfStack.Navigator screenOptions={{ headerShown: false }}>
      <BookshelfStack.Screen name="BookshelfHome" component={BookshelfScreen} />
      <BookshelfStack.Screen name="Reader" component={ReaderScreen} />
    </BookshelfStack.Navigator>
  );
}

// 划线复盘tab同样需要自己的堆栈——点卡片"推入"详情页；"跳转到原文"从详情页
// 跨tab导航回书架堆栈的 Reader（见 ReviewDetailScreen.js）
function ReviewStackScreen() {
  return (
    <ReviewStack.Navigator screenOptions={{ headerShown: false }}>
      <ReviewStack.Screen name="ReviewHome" component={ReviewScreen} />
      <ReviewStack.Screen name="ReviewBook" component={ReviewBookScreen} />
      <ReviewStack.Screen name="ReviewDetail" component={ReviewDetailScreen} />
    </ReviewStack.Navigator>
  );
}

function getTabBarStyle(route, visibleStyle) {
  const focusedRoute = getFocusedRouteNameFromRoute(route) ?? 'BookshelfHome';
  if (['Reader', 'ReviewBook', 'ReviewDetail'].includes(focusedRoute)) return { display: 'none' };
  return visibleStyle;
}

export default function App() {
  const theme = useTheme();
  const [fontsLoaded] = useFonts(FONT_ASSETS);
  const tabBarStyle = { backgroundColor: theme.cardBg, borderTopColor: theme.cardBorder };

  // 阶段十三：登录态守卫。authChecked=false 期间不知道用户登没登录过，
  // 先转圈，不能默认展示任何一边——直接默认展示书架会闪一下已登录界面，
  // 默认展示登录页会让已登录用户每次开App都先看一眼登录页再跳走。
  const [authChecked, setAuthChecked] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    loadStoredToken().then(() => {
      setLoggedIn(isLoggedIn());
      setAuthChecked(true);
    });
    // token失效（过期/被后端拒绝）时 appFetch 会广播这个事件，统一弹回登录页。
    return onAuthExpired(() => setLoggedIn(false));
  }, []);

  const handleLoggedIn = useCallback(() => setLoggedIn(true), []);

  if (!fontsLoaded || !authChecked) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg }}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (!loggedIn) {
    return (
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <LoginScreen onLoggedIn={handleLoggedIn} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <BottomSheetModalProvider>
          <ReaderProvider>
            <NavigationContainer>
              <StatusBar style="auto" />
              <Tab.Navigator
                screenOptions={({ route }) => ({
                  headerShown: false,
                  tabBarActiveTintColor: theme.accent,
                  tabBarInactiveTintColor: theme.textMuted,
                  tabBarStyle,
                  tabBarIcon: ({ color, size }) => {
                    const IconComponent = TAB_ICON_COMPONENT[route.name];
                    return <IconComponent color={color} size={size} strokeWidth={1.75} />;
                  },
                })}
              >
                <Tab.Screen
                  name="书架"
                  component={BookshelfStackScreen}
                  options={({ route }) => ({ tabBarStyle: getTabBarStyle(route, tabBarStyle) })}
                />
                <Tab.Screen
                  name="划线复盘"
                  component={ReviewStackScreen}
                  options={({ route }) => ({
                    tabBarStyle: getTabBarStyle(route, tabBarStyle),
                    // 切到别的tab再切回来，要回到总览列表，不能停在上次看的详情页。
                    // 上一版用的 unmountOnBlur 在装的这个 react-navigation 版本里
                    // 根本不存在（凭记忆写的，没查证，等于没修）——查了源码
                    // （@react-navigation/bottom-tabs 的 BottomTabView.js）确认
                    // popToTopOnBlur 才是这个版本真正支持、专门给"tab下面挂了个
                    // stack 导航"这种场景设计的选项：离开这个tab时把嵌套的 stack
                    // pop 回第一页（ReviewHome）。
                    popToTopOnBlur: true,
                  })}
                />
                <Tab.Screen name="我的" component={ProfileScreen} />
              </Tab.Navigator>
            </NavigationContainer>
          </ReaderProvider>
        </BottomSheetModalProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
