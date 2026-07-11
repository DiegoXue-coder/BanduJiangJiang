import React from 'react';
import { Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ReaderProvider } from '@epubjs-react-native/core';

import BookshelfScreen from './screens/BookshelfScreen';
import ReaderScreen from './screens/ReaderScreen';
import ReviewScreen from './screens/ReviewScreen';
import ProfileScreen from './screens/ProfileScreen';

const BLUE = '#4f8ef7';
const TAB_ICON = { 书架: '📚', 划线复盘: '✍️', 我的: '👤' };

const Tab = createBottomTabNavigator();
const BookshelfStack = createNativeStackNavigator();

// 书架tab自己的堆栈——点书本卡片会"推入"阅读器页面，阅读器时隐藏底部tab栏
function BookshelfStackScreen() {
  return (
    <BookshelfStack.Navigator screenOptions={{ headerShown: false }}>
      <BookshelfStack.Screen name="BookshelfHome" component={BookshelfScreen} />
      <BookshelfStack.Screen name="Reader" component={ReaderScreen} />
    </BookshelfStack.Navigator>
  );
}

function getTabBarStyle(route) {
  const focusedRoute = getFocusedRouteNameFromRoute(route) ?? 'BookshelfHome';
  if (focusedRoute === 'Reader') return { display: 'none' };
  return undefined;
}

export default function App() {
  return (
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
          <Tab.Screen name="划线复盘" component={ReviewScreen} />
          <Tab.Screen name="我的" component={ProfileScreen} />
        </Tab.Navigator>
      </NavigationContainer>
    </ReaderProvider>
  );
}
