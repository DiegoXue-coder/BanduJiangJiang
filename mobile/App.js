import React from 'react';
import { Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ReaderProvider } from '@epubjs-react-native/core';

import BookshelfScreen from './screens/BookshelfScreen';
import ReaderScreen from './screens/ReaderScreen';
import BookChatScreen from './screens/BookChatScreen';
import ReviewScreen from './screens/ReviewScreen';
import ReviewDetailScreen from './screens/ReviewDetailScreen';
import ProfileScreen from './screens/ProfileScreen';

const BLUE = '#4f8ef7';
const TAB_ICON = { 书架: '📚', 划线复盘: '✍️', 我的: '👤' };

const Tab = createBottomTabNavigator();
const BookshelfStack = createNativeStackNavigator();
const ReviewStack = createNativeStackNavigator();

// 书架tab自己的堆栈——点书本卡片会"推入"阅读器页面，阅读器时隐藏底部tab栏
function BookshelfStackScreen() {
  return (
    <BookshelfStack.Navigator screenOptions={{ headerShown: false }}>
      <BookshelfStack.Screen name="BookshelfHome" component={BookshelfScreen} />
      <BookshelfStack.Screen name="Reader" component={ReaderScreen} />
      <BookshelfStack.Screen name="BookChat" component={BookChatScreen} />
    </BookshelfStack.Navigator>
  );
}

// 划线复盘tab同样需要自己的堆栈——点卡片"推入"详情页；"跳转到原文"从详情页
// 跨tab导航回书架堆栈的 Reader（见 ReviewDetailScreen.js）
function ReviewStackScreen() {
  return (
    <ReviewStack.Navigator screenOptions={{ headerShown: false }}>
      <ReviewStack.Screen name="ReviewHome" component={ReviewScreen} />
      <ReviewStack.Screen name="ReviewDetail" component={ReviewDetailScreen} />
    </ReviewStack.Navigator>
  );
}

function getTabBarStyle(route) {
  const focusedRoute = getFocusedRouteNameFromRoute(route) ?? 'BookshelfHome';
  if (['Reader', 'BookChat', 'ReviewDetail'].includes(focusedRoute)) return { display: 'none' };
  return undefined;
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ReaderProvider>
        <NavigationContainer>
          <StatusBar style="auto" />
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerShown: false,
              tabBarActiveTintColor: BLUE,
              tabBarInactiveTintColor: '#8a95b0',
              tabBarIcon: ({ color }) => (
                <Text style={{ fontSize: 18, color }}>{TAB_ICON[route.name]}</Text>
              ),
            })}
          >
            <Tab.Screen
              name="书架"
              component={BookshelfStackScreen}
              options={({ route }) => ({ tabBarStyle: getTabBarStyle(route) })}
            />
            <Tab.Screen
              name="划线复盘"
              component={ReviewStackScreen}
              options={({ route }) => ({
                tabBarStyle: getTabBarStyle(route),
                // 切到别的tab再切回来，要回到总览列表，不能停在上次看的详情页——
                // unmountOnBlur 让离开这个tab时把整个堆栈（含 ReviewDetail）
                // 卸载掉，回来时从堆栈的第一个页面（ReviewHome）重新挂载
                unmountOnBlur: true,
              })}
            />
            <Tab.Screen name="我的" component={ProfileScreen} />
          </Tab.Navigator>
        </NavigationContainer>
      </ReaderProvider>
    </GestureHandlerRootView>
  );
}
