import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { StatusBar } from 'expo-status-bar';
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
import { useTheme } from './theme';

// 阶段十一：底部tab从emoji换成Tabler Icons（MIT协议，免费商用）
const TAB_ICON_COMPONENT = { 书架: IconBooks, 划线复盘: IconHighlight, 我的: IconUserCircle };

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
  const tabBarStyle = { backgroundColor: theme.cardBg, borderTopColor: theme.cardBorder };
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
                    return <IconComponent color={color} size={size} stroke={1.75} />;
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
