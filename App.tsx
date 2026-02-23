/**
 * Ritu IVF Mobile App – Bottom navigation, call logs, push to portal.
 */

import React from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { HomeScreen } from './src/screens/HomeScreen';
import { CallLogsScreen } from './src/screens/CallLogsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { theme } from './src/theme';

const Tab = createBottomTabNavigator();

function TabIcon({
  name,
  focused,
}: {
  name: 'home-outline' | 'phone-log' | 'cog-outline';
  focused: boolean;
}) {
  return (
    <Icon
      name={name}
      size={24}
      color={focused ? theme.colors.primary : theme.colors.tabInactive}
    />
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={theme.colors.white} />
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarStyle: {
              backgroundColor: theme.colors.white,
              borderTopColor: theme.colors.cardBorder,
              borderTopWidth: 1,
              height: 64,
              paddingBottom: 8,
              paddingTop: 8,
              elevation: 8,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: -2 },
              shadowOpacity: 0.06,
              shadowRadius: 8,
            },
            tabBarActiveTintColor: theme.colors.primary,
            tabBarInactiveTintColor: theme.colors.tabInactive,
            tabBarLabelStyle: {
              fontSize: 12,
              fontWeight: '600',
            },
            tabBarItemStyle: {},
          }}
        >
          <Tab.Screen
            name="Home"
            component={HomeScreen}
            options={{
              tabBarIcon: ({ focused }) => (
                <TabIcon name="home-outline" focused={focused} />
              ),
            }}
          />
          <Tab.Screen
            name="CallLogs"
            component={CallLogsScreen}
            options={{
              title: 'Call logs',
              tabBarIcon: ({ focused }) => (
                <TabIcon name="phone-log" focused={focused} />
              ),
            }}
          />
          <Tab.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              tabBarIcon: ({ focused }) => (
                <TabIcon name="cog-outline" focused={focused} />
              ),
            }}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
