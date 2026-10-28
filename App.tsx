/**
 * Gaincafe CRM Mobile App – agent login, leads (tap to call), call logs, sync to CRM.
 * Scheduled sync runs every 30 minutes and when app becomes active.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, AppStateStatus, StatusBar, StyleSheet, View } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import NetInfo from '@react-native-community/netinfo';
import { runScheduledSync, shouldRunSyncNow } from './src/services/syncSchedule';
import { refreshWorkspaceInfo, useSession } from './src/services/auth';
import { refreshLeadPhoneIndex } from './src/services/leadIndex';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { HomeScreen } from './src/screens/HomeScreen';
import { LeadsScreen } from './src/screens/LeadsScreen';
import { CallLogsScreen } from './src/screens/CallLogsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { AttachRecordingSheet } from './src/components/AttachRecordingSheet';
import { getPendingShares, subscribeShares, type SharedFile } from './src/services/shareReceiver';
import { theme } from './src/theme';

const Tab = createBottomTabNavigator();

function TabIcon({
  name,
  focused,
}: {
  name: 'home-outline' | 'account-multiple-outline' | 'phone-log' | 'cog-outline';
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
const TAB_BAR_BASE_HEIGHT = 64;

/** Bottom tabs, sized for the gesture navigation bar (edge-to-edge Android). */
function MainTabs() {
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.colors.white,
          borderTopColor: theme.colors.cardBorder,
          borderTopWidth: 1,
          height: TAB_BAR_BASE_HEIGHT + insets.bottom,
          paddingBottom: 8 + insets.bottom,
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
          tabBarIcon: ({ focused }) => <TabIcon name="home-outline" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Leads"
        component={LeadsScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="account-multiple-outline" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="CallLogs"
        component={CallLogsScreen}
        options={{
          title: 'Call logs',
          tabBarIcon: ({ focused }) => <TabIcon name="phone-log" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="cog-outline" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  const session = useSession();
  const sessionToken = session?.token;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // After login (or app start with a stored session) fetch the CRM lead numbers
    // so call logs can be filtered to lead calls before the first sync runs.
    if (sessionToken) {
      refreshLeadPhoneIndex();
      refreshWorkspaceInfo();
    }
  }, [sessionToken]);

  // "Share to Gaincafe CRM": recordings shared from the dialer wait here until
  // the agent is signed in, then one sheet per file asks which call it belongs to.
  const [sharedQueue, setSharedQueue] = useState<SharedFile[]>([]);
  const enqueueShares = useCallback((files: SharedFile[]) => {
    if (files.length === 0) return;
    setSharedQueue((prev) => {
      const known = new Set(prev.map((f) => f.path));
      return [...prev, ...files.filter((f) => !known.has(f.path))];
    });
  }, []);

  useEffect(() => {
    getPendingShares().then(enqueueShares);
    const unsubscribe = subscribeShares(enqueueShares);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') getPendingShares().then(enqueueShares);
    });
    return () => {
      unsubscribe();
      sub.remove();
    };
  }, [enqueueShares]);

  const currentShare = sessionToken ? sharedQueue[0] ?? null : null;
  const finishShare = useCallback(() => {
    setSharedQueue((prev) => prev.slice(1));
  }, []);
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

  if (session === undefined) {
    // Reading the stored session; avoid flashing the login screen.
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" backgroundColor={theme.colors.white} />
        <View style={styles.splash}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </SafeAreaProvider>
    );
  }

  if (session === null) {
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" backgroundColor={theme.colors.white} />
        <LoginScreen />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={theme.colors.white} />
      <NavigationContainer>
        <MainTabs />
      </NavigationContainer>
      {currentShare ? (
        <AttachRecordingSheet key={currentShare.path} file={currentShare} onDone={finishShare} />
      ) : null}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundSecondary,
  },
});
