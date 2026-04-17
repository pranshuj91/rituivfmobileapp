/**
 * Ritu IVF Mobile App – Bottom navigation, call logs, push to portal.
 * Scheduled sync runs every 30 minutes and when app becomes active.
 */

import React, { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, StatusBar } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import NetInfo from '@react-native-community/netinfo';
import { runScheduledSync, shouldRunSyncNow } from './src/services/syncSchedule';
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

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const BACKGROUND_FETCH_INTERVAL_MINUTES = 30;

export default function App() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const wasConnectedRef = useRef<boolean>(true);

  useEffect(() => {
    // Run sync once shortly after launch if threshold passed (or never synced)
    const t = setTimeout(() => {
      shouldRunSyncNow().then((ok) => {
        if (ok) runScheduledSync();
      });
    }, 2000);

    // Every 30 minutes while app is in memory
    intervalRef.current = setInterval(runScheduledSync, THIRTY_MINUTES_MS);

    const sub = AppState.addEventListener('change', (nextState) => {
      const becameActive =
        appStateRef.current.match(/inactive|background/) && nextState === 'active';
      appStateRef.current = nextState;
      if (becameActive) {
        shouldRunSyncNow().then((ok) => {
          if (ok) runScheduledSync();
        });
      }
    });
    const netSub = NetInfo.addEventListener((state) => {
      const isConnected = !!state.isConnected && state.isInternetReachable !== false;
      const becameConnected = !wasConnectedRef.current && isConnected;
      wasConnectedRef.current = isConnected;
      if (becameConnected) {
        runScheduledSync();
      }
    });

    return () => {
      clearTimeout(t);
      if (intervalRef.current) clearInterval(intervalRef.current);
      sub.remove();
      netSub();
    };
  }, []);

  useEffect(() => {
    // Native background scheduler (Android WorkManager/JobScheduler).
    // This can run even when app is not foregrounded.
    BackgroundFetch.configure(
      {
        minimumFetchInterval: BACKGROUND_FETCH_INTERVAL_MINUTES,
        stopOnTerminate: false,
        startOnBoot: true,
        enableHeadless: true,
        requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
      },
      async (taskId) => {
        try {
          await runScheduledSync();
        } finally {
          BackgroundFetch.finish(taskId);
        }
      },
      (taskId) => {
        BackgroundFetch.finish(taskId);
      }
    ).catch(() => {
      // Keep app running even if background fetch init fails.
    });
  }, []);

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
