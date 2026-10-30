import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  PermissionsAndroid,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import CallLogs from 'react-native-call-log';
import type { CallLog } from 'react-native-call-log';
import { enrichCallLogsWithContactNames } from '../services/callLogNames';
import {
  getLastSyncedAt,
  getSyncedCallIds,
  pushCallsToPortal,
  pushSingleCallToPortal,
  setLastSyncedAt,
} from '../services/portal';
import { buildRecordingSyncOptions } from '../services/recordings';
import {
  filterLeadCalls,
  findLeadForCall,
  getLeadPhoneIndex,
  type LeadPhoneIndex,
} from '../services/leadIndex';
import { getAllCallSyncEnabled } from '../services/appSettings';
import { theme } from '../theme';

const CALL_LOG_PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
  PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  ...(Number(Platform.Version) >= 33
    ? [PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO]
    : [PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE]),
  ...(Number(Platform.Version) >= 26
    ? [PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS]
    : []),
];
const AUTO_REFRESH_MS = 60 * 1000;

/** What each permission is for, shown before the system prompts appear. */
const PERMISSION_EXPLAINERS: Array<{ icon: string; title: string; text: string }> = [
  {
    icon: 'phone-log',
    title: 'Call history',
    text: 'To show your calls with CRM leads and sync them.',
  },
  {
    icon: 'cellphone-information',
    title: 'Phone status',
    text: 'To know which number this phone uses.',
  },
  {
    icon: 'music-box-multiple-outline',
    title: 'Audio files',
    text: 'To find the call recordings saved by your dialer.',
  },
];

function PermissionExplainer({
  visible,
  onAllow,
  onClose,
}: {
  visible: boolean;
  onAllow: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalIconWrap}>
            <Icon name="shield-check-outline" size={34} color={theme.colors.primary} />
          </View>
          <Text style={styles.modalTitle}>Allow access</Text>
          <Text style={styles.modalSubtitle}>
            The app needs a few permissions to work. Android will ask you to confirm each one next.
          </Text>
          {PERMISSION_EXPLAINERS.map((p) => (
            <View key={p.title} style={styles.modalRow}>
              <View style={styles.modalRowIcon}>
                <Icon name={p.icon} size={20} color={theme.colors.primary} />
              </View>
              <View style={styles.modalRowText}>
                <Text style={styles.modalRowTitle}>{p.title}</Text>
                <Text style={styles.modalRowHint}>{p.text}</Text>
              </View>
            </View>
          ))}
          <Text style={styles.modalNote}>
            Only calls with CRM lead numbers are read and synced. Nothing else leaves your phone.
          </Text>
          <TouchableOpacity style={styles.modalPrimary} onPress={onAllow}>
            <Text style={styles.modalPrimaryText}>Continue</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.modalSecondary} onPress={onClose}>
            <Text style={styles.modalSecondaryText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface CallLogItemProps {
  item: CallLog;
  onPush: (call: CallLog) => void;
  pushing: boolean;
  synced: boolean;
  leadName?: string;
}

function formatLastSync(ms: number | null): string {
  if (!ms) return 'Last sync: never';
  return `Last sync: ${new Date(ms).toLocaleString()}`;
}

function CallLogItemRow({ item, onPush, pushing, synced, leadName }: CallLogItemProps) {
  return (
    <View style={styles.logItem}>
      <View style={styles.logMain}>
        <View style={styles.logRow}>
          <Text style={styles.logNumber} numberOfLines={1}>
            {item.formattedNumber || item.phoneNumber || 'Unknown'}
          </Text>
          <View style={styles.typeBadge}>
            <Text style={styles.logType}>{item.type}</Text>
          </View>
        </View>
        <View style={styles.logMeta}>
          <Text style={styles.logDate}>{item.dateTime}</Text>
          <Text style={styles.logDuration}>{formatDuration(item.duration)}</Text>
        </View>
        {item.name ? (
          <Text style={styles.logName} numberOfLines={1}>{item.name}</Text>
        ) : null}
        {leadName ? (
          <View style={styles.leadRow}>
            <Icon name="account-check-outline" size={14} color={theme.colors.primary} />
            <Text style={styles.leadName} numberOfLines={1}>Lead: {leadName}</Text>
          </View>
        ) : null}
      </View>
      {synced ? (
        <View style={styles.syncedBadge}>
          <Icon name="check-circle" size={20} color={theme.colors.success} />
          <Text style={styles.syncedText}>Synced</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.pushBtn}
          onPress={() => onPush(item)}
          disabled={pushing}
        >
          {pushing ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : (
            <Icon name="cloud-upload-outline" size={22} color={theme.colors.primary} />
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

export function CallLogsScreen() {
  const insets = useSafeAreaInsets();
  const loadingRef = useRef(false);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [pushingId, setPushingId] = useState<string | 'all' | null>(null);
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAtMs, setLastSyncedAtMs] = useState<number | null>(null);
  const [leadIndex, setLeadIndex] = useState<LeadPhoneIndex | null>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [showExplainer, setShowExplainer] = useState(false);
  const [allCallSync, setAllCallSync] = useState(false);

  const refreshLastSync = useCallback(async () => {
    const [last, ids] = await Promise.all([getLastSyncedAt(), getSyncedCallIds()]);
    setLastSyncedAtMs(last);
    // Calls the CRM has acknowledged, persisted across app restarts. Only replace
    // the in-session set when the stored list has something, so ticks from a
    // push made moments ago are never lost.
    if (ids.size > 0) setSyncedIds((prev) => new Set([...prev, ...ids]));
  }, []);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    refreshLastSync();
  }, [refreshLastSync]);

  const requestPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') {
      setError('Call logs are only supported on Android.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await PermissionsAndroid.requestMultiple(CALL_LOG_PERMISSIONS);
      const allGranted = Object.values(result).every(
        (s) => s === PermissionsAndroid.RESULTS.GRANTED
      );
      setPermissionGranted(allGranted);
      if (!allGranted) {
        const denied = Object.entries(result)
          .filter(([, s]) => s !== PermissionsAndroid.RESULTS.GRANTED)
          .map(([p]) => p);
        setError(`Permission denied: ${denied.join(', ')}. Enable in Settings if needed.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Permission request failed');
      setPermissionGranted(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Already-granted permissions: skip the explainer and the system prompts.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    Promise.all(CALL_LOG_PERMISSIONS.map((p) => PermissionsAndroid.check(p)))
      .then((results) => {
        if (results.every(Boolean)) setPermissionGranted(true);
      })
      .catch(() => undefined);
  }, []);

  const onAllowPressed = useCallback(() => {
    setShowExplainer(false);
    // Let the modal close before the system dialogs open.
    setTimeout(() => {
      requestPermissions();
    }, 150);
  }, [requestPermissions]);

  const loadCallLogs = useCallback(async (silent = false) => {
    if (Platform.OS !== 'android') return;
    if (loadingRef.current) return;
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      // Only calls with CRM lead numbers are shown and synced; load a wider
      // window from the device because most entries are filtered out.
      const list = await CallLogs.load(300);
      const enriched = await enrichCallLogsWithContactNames(list);
      const allCalls = await getAllCallSyncEnabled();
      setAllCallSync(allCalls);
      const index = await getLeadPhoneIndex();
      setLeadIndex(index);
      if (allCalls) {
        // "All call sync" on: every call is listed and synced.
        setLogs(enriched);
        setHiddenCount(0);
      } else if (!index) {
        setLogs([]);
        setHiddenCount(0);
        if (!silent) {
          setError('Could not load the CRM lead list. Connect to the internet and tap "Load calls" again.');
        }
      } else {
        const leadCalls = filterLeadCalls(index, enriched);
        setLogs(leadCalls);
        setHiddenCount(enriched.length - leadCalls.length);
      }
      await refreshLastSync();
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : 'Failed to load call logs');
        setLogs([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [refreshLastSync]);

  useFocusEffect(
    useCallback(() => {
      if (permissionGranted !== true) return undefined;
      loadCallLogs(true);
      const id = setInterval(() => {
        loadCallLogs(true);
      }, AUTO_REFRESH_MS);
      return () => clearInterval(id);
    }, [permissionGranted, loadCallLogs])
  );

  const handlePushOne = useCallback(async (call: CallLog) => {
    try {
      setPushingId(call.id);
      const syncOptions = await buildRecordingSyncOptions([call]);
      const result = await pushSingleCallToPortal(call, syncOptions, 'manual');
      if (result.success) {
        setSyncedIds((prev) => new Set([...prev, call.id]));
        const now = Date.now();
        await setLastSyncedAt(now);
        setLastSyncedAtMs(now);
      }
      Alert.alert(result.success ? 'Sent' : 'Error', result.message);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to push call';
      Alert.alert('Error', msg);
    } finally {
      setPushingId(null);
    }
  }, []);

  const handlePushAll = useCallback(async () => {
    if (logs.length === 0) {
      Alert.alert('No calls', 'Load call logs first.');
      return;
    }
    try {
      setPushingId('all');
      const syncOptions = await buildRecordingSyncOptions(logs);
      const result = await pushCallsToPortal(logs, syncOptions, 'manual');
      // The CRM acknowledges logs per batch; read back exactly which ones it
      // accepted instead of marking everything as synced on success.
      setSyncedIds(await getSyncedCallIds());
      if (result.success) {
        const now = Date.now();
        await setLastSyncedAt(now);
        setLastSyncedAtMs(now);
      }
      Alert.alert(result.success ? 'Sent' : 'Error', result.message);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to push calls';
      Alert.alert('Error', msg);
    } finally {
      setPushingId(null);
    }
  }, [logs]);

  const handleOpenSettings = () => {
    Alert.alert(
      'Open Settings',
      'Grant READ_CALL_LOG and READ_PHONE_STATE in App permissions, then return and tap "Load call logs".',
      [{ text: 'OK' }]
    );
  };

  const padding = { paddingTop: insets.top + theme.spacing.md, paddingBottom: insets.bottom };

  if (Platform.OS !== 'android') {
    return (
      <View style={[styles.container, padding]}>
        <Text style={styles.title}>Call logs</Text>
        <Text style={styles.subtitle}>Call log access is only available on Android.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, padding]}>
      <View style={styles.header}>
        <Text style={styles.title}>Call logs</Text>
        <Text style={styles.subtitle}>
          {allCallSync ? 'All calls on this phone' : 'Calls with CRM leads only'}
          {!allCallSync && hiddenCount > 0 ? ` · ${hiddenCount} other call${hiddenCount === 1 ? '' : 's'} hidden` : ''}
        </Text>
        <Text style={styles.lastSyncText}>{formatLastSync(lastSyncedAtMs)}</Text>
      </View>

      <PermissionExplainer
        visible={showExplainer}
        onAllow={onAllowPressed}
        onClose={() => setShowExplainer(false)}
      />

      {permissionGranted === null && (
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => setShowExplainer(true)}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={theme.colors.textOnPrimary} />
          ) : (
            <>
              <Icon name="shield-check" size={22} color={theme.colors.textOnPrimary} />
              <Text style={styles.primaryButtonText}>Grant permissions</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {permissionGranted === true && (
        <>
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => loadCallLogs(false)}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={theme.colors.primary} size="small" />
              ) : (
                <>
                  <Icon name="reload" size={20} color={theme.colors.primary} />
                  <Text style={styles.secondaryButtonText}>Load calls</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.pushAllButton}
              onPress={handlePushAll}
              disabled={logs.length === 0 || pushingId === 'all'}
            >
              {pushingId === 'all' ? (
                <ActivityIndicator color={theme.colors.textOnPrimary} size="small" />
              ) : (
                <>
                  <Icon name="cloud-upload" size={20} color={theme.colors.textOnPrimary} />
                  <Text style={styles.pushAllButtonText}>Push to portal</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity onPress={handleOpenSettings}>
                <Text style={styles.link}>Open app settings</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <FlatList
            data={logs}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <CallLogItemRow
                item={item}
                onPush={handlePushOne}
                pushing={pushingId === item.id}
                synced={syncedIds.has(item.id)}
                leadName={findLeadForCall(leadIndex, item)?.name || undefined}
              />
            )}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              !loading && permissionGranted ? (
                <Text style={styles.empty}>
                  {allCallSync
                    ? 'No calls on this phone yet. Tap "Load calls" after your next call.'
                    : 'No calls with CRM leads yet. Call a lead from the Leads tab, then tap "Load calls".'}
                </Text>
              ) : null
            }
          />
        </>
      )}

      {permissionGranted === false && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? 'Permissions were denied.'}</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => setShowExplainer(true)} disabled={loading}>
            <Text style={styles.primaryButtonText}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleOpenSettings}>
            <Text style={styles.link}>Open app settings</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundSecondary,
    paddingHorizontal: theme.spacing.lg,
  },
  header: {
    marginBottom: theme.spacing.md,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: theme.colors.text,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.xs,
  },
  lastSyncText: {
    fontSize: 12,
    color: theme.colors.tabInactive,
    marginTop: 4,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  primaryButtonText: {
    color: theme.colors.textOnPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.white,
    paddingVertical: theme.spacing.sm + 4,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    gap: theme.spacing.xs,
  },
  secondaryButtonText: {
    color: theme.colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  pushAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.sm + 4,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    gap: theme.spacing.xs,
  },
  pushAllButtonText: {
    color: theme.colors.textOnPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  list: {
    flex: 1,
    marginTop: theme.spacing.sm,
  },
  listContent: {
    paddingBottom: theme.spacing.xl,
  },
  logItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.primary,
    ...theme.shadows.sm,
  },
  logMain: {
    flex: 1,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  logNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
    flex: 1,
  },
  typeBadge: {
    backgroundColor: theme.colors.backgroundSecondary,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.sm,
  },
  logType: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
  logMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: theme.spacing.xs,
  },
  logDate: {
    fontSize: 13,
    color: theme.colors.textSecondary,
  },
  logDuration: {
    fontSize: 13,
    color: theme.colors.textSecondary,
  },
  logName: {
    fontSize: 13,
    color: theme.colors.tabInactive,
    marginTop: 2,
  },
  leadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  leadName: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.primary,
    flex: 1,
  },
  pushBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: theme.spacing.xs,
  },
  syncedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: theme.spacing.xs,
  },
  syncedText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.success,
  },
  errorBox: {
    backgroundColor: theme.colors.white,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.error,
    marginBottom: theme.spacing.sm,
  },
  errorText: {
    color: theme.colors.error,
    fontSize: 14,
    marginBottom: theme.spacing.xs,
  },
  link: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  empty: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    marginTop: theme.spacing.lg,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(28, 25, 23, 0.55)',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
  modalCard: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg + 4,
    padding: theme.spacing.lg,
    alignItems: 'stretch',
    ...theme.shadows.md,
  },
  modalIconWrap: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.colors.backgroundSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.md,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: theme.colors.text,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.md,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm + 4,
    paddingVertical: theme.spacing.sm,
  },
  modalRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.backgroundSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalRowText: {
    flex: 1,
  },
  modalRowTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.text,
  },
  modalRowHint: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 18,
    marginTop: 1,
  },
  modalNote: {
    fontSize: 12,
    color: theme.colors.tabInactive,
    textAlign: 'center',
    lineHeight: 17,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  modalPrimary: {
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    alignItems: 'center',
  },
  modalPrimaryText: {
    color: theme.colors.textOnPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  modalSecondary: {
    paddingVertical: theme.spacing.sm + 4,
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
  modalSecondaryText: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
});
