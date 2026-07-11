import React from 'react';
import { Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import BookshelfScreen from './screens/BookshelfScreen';
import ReviewScreen from './screens/ReviewScreen';
import ProfileScreen from './screens/ProfileScreen';

const BLUE = '#4f8ef7';
const TAB_ICON = { 书架: '📚', 划线复盘: '✍️', 我的: '👤' };

const Tab = createBottomTabNavigator();

export default function App() {
  return (
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
        <Tab.Screen name="书架" component={BookshelfScreen} />
        <Tab.Screen name="划线复盘" component={ReviewScreen} />
        <Tab.Screen name="我的" component={ProfileScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
