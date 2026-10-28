import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  PermissionsAndroid,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, type NavigationProp } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import CallLogs from 'react-native-call-log';
import type { CallLog } from 'react-native-call-log';
import { featureMissing, useSession } from '../services/auth';
import { dialLead, fetchLeads, leadStatusMeta, type Lead } from '../services/crm';
import { findLeadForCall, getLeadPhoneIndex, type LeadPhoneIndex } from '../services/leadIndex';
import { getAllCallSyncEnabled } from '../services/appSettings';
import { getLastSyncedAt, getSyncedCallIds } from '../services/portal';
import { runScheduledSync } from '../services/syncSchedule';
import { AppDialog, type AppDialogProps } from '../components/AppDialog';
import { theme } from '../theme';

type DialogState = Omit<AppDialogProps, 'visible'>;
type TabNav = NavigationProp<Record<string, object | undefined>>;

const RECENT_LIMIT = 5;
const FOLLOW_UP_LIMIT = 5;

interface RecentCall {
  id: string;
  name: string;
  phone: string;
  direction: string;
  timeMs: number;
  duration: number;
  leadStatus?: string;
  synced: boolean;
}

function callTimeMs(c: CallLog): number {
  const raw = typeof c.timestamp === 'string' ? Number(c.timestamp) : c.timestamp;
  if (Number.isFinite(raw)) return (raw as number) > 1e12 ? (raw as number) : (raw as number) * 1000;
  if (c.dateTime) {
    const t = Date.parse(c.dateTime);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = startOfToday();
  if (ms >= today) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFollowUp(value?: string | null): string {
  if (!value) return '';
  const t = Date.parse(value.replace(' ', 'T'));
  if (!Number.isFinite(t)) return value;
  const today = startOfToday();
  if (t < today) return 'Overdue';
  if (t < today + 24 * 60 * 60 * 1000) return 'Today';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function directionIcon(direction: string): { name: string; color: string } {
  const d = direction.toUpperCase();
  if (d.includes('MISSED') || d.includes('REJECTED')) return { name: 'phone-missed', color: theme.colors.error };
  if (d.includes('INCOMING')) return { name: 'phone-incoming', color: '#0891B2' };
  return { name: 'phone-outgoing', color: theme.colors.success };
}

function StatTile({ icon, value, label, color }: { icon: string; value: string; label: string; color: string }) {
  return (
    <View style={styles.statTile}>
      <View style={[styles.statIcon, { backgroundColor: `${color}1A` }]}>
        <Icon name={icon} size={18} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const session = useSession();
  const navigation = useNavigation<TabNav>();
  const callSyncMissing = featureMissing(session, 'call-sync');
  const leadsMissing = featureMissing(session, 'patient-enquiries');
  const workspaceLogo = session?.workspace?.logoUrl;
  const workspaceName = (session?.workspace?.name || '').trim();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasCallPermission, setHasCallPermission] = useState<boolean | null>(null);
  const [todayCalls, setTodayCalls] = useState(0);
  const [todaySynced, setTodaySynced] = useState(0);
  const [recent, setRecent] = useState<RecentCall[]>([]);
  const [followUps, setFollowUps] = useState<Lead[]>([]);
  const [lastSyncMs, setLastSyncMs] = useState<number | null>(null);
  const [allCallSync, setAllCallSync] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);

  const loadCalls = useCallback(async (
    index: LeadPhoneIndex | null,
    allCalls: boolean,
    syncedIds: Set<string>,
    lastSync: number | null
  ) => {
    // Calls acknowledged by the CRM count as synced. Before this list existed,
    // fall back to "older than the last successful sync" so history stays right.
    const isSynced = (c: CallLog): boolean =>
      syncedIds.has(String(c.id)) || (syncedIds.size === 0 && lastSync != null && callTimeMs(c) <= lastSync);
    if (Platform.OS !== 'android') {
      setHasCallPermission(false);
      return;
    }
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CALL_LOG);
    setHasCallPermission(granted);
    if (!granted) {
      setTodayCalls(0);
      setTodaySynced(0);
      setRecent([]);
      return;
    }
    const logs = await CallLogs.load(200);
    const leadCalls = logs.filter((c) => allCalls || !!findLeadForCall(index, c));
    const today = startOfToday();
    const todays = leadCalls.filter((c) => callTimeMs(c) >= today);
    setTodayCalls(todays.length);
    setTodaySynced(todays.filter(isSynced).length);
    const recentCalls: RecentCall[] = [...leadCalls]
      .sort((a, b) => callTimeMs(b) - callTimeMs(a))
      .slice(0, RECENT_LIMIT)
      .map((c) => {
        const lead = findLeadForCall(index, c);
        const phone = c.formattedNumber || c.phoneNumber || '';
        return {
          id: c.id,
          name: lead?.name || (c.name || '').trim() || phone,
          phone,
          direction: String(c.type ?? ''),
          timeMs: callTimeMs(c),
          duration: c.duration,
          leadStatus: lead?.status,
          synced: isSynced(c),
        };
      });
    setRecent(recentCalls);
  }, []);

  const loadFollowUps = useCallback(async () => {
    try {
      const page = await fetchLeads({ status: ['follow_up'], perPage: 100 });
      const cutoff = startOfToday() + 24 * 60 * 60 * 1000;
      const due = page.items
        .filter((l) => {
          if (!l.follow_up_date) return false;
          const t = Date.parse(String(l.follow_up_date).replace(' ', 'T'));
          return Number.isFinite(t) && t < cutoff;
        })
        .sort((a, b) => Date.parse(String(a.follow_up_date)) - Date.parse(String(b.follow_up_date)))
        .slice(0, FOLLOW_UP_LIMIT);
      setFollowUps(due);
    } catch {
      setFollowUps([]);
    }
  }, []);

  const load = useCallback(async (mode: 'initial' | 'refresh') => {
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    try {
      const [index, allCalls, lastSync, syncedIds] = await Promise.all([
        getLeadPhoneIndex(),
        getAllCallSyncEnabled(),
        getLastSyncedAt(),
        getSyncedCallIds(),
      ]);
      setAllCallSync(allCalls);
      setLastSyncMs(lastSync);
      await Promise.all([
        loadCalls(index, allCalls, syncedIds, lastSync).catch(() => undefined),
        loadFollowUps(),
      ]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadCalls, loadFollowUps]);

  useFocusEffect(
    useCallback(() => {
      load(loading ? 'initial' : 'refresh');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const onSyncNow = useCallback(async () => {
    setSyncing(true);
    setDialog({ title: 'Syncing…', message: 'Checking new calls and sending them to the CRM.', loading: true });
    try {
      const result = await runScheduledSync();
      await load('refresh');
      const tone = result.status === 'synced'
        ? 'success'
        : result.status === 'failed'
          ? 'error'
          : result.status === 'skipped'
            ? 'warning'
            : 'info';
      const title = result.status === 'synced'
        ? 'Sync complete'
        : result.status === 'nothing'
          ? 'Nothing new to sync'
          : result.status === 'failed'
            ? 'Sync failed'
            : 'Sync skipped';
      setDialog({ tone, title, message: result.message, primaryLabel: 'OK', onPrimary: closeDialog });
    } finally {
      setSyncing(false);
    }
  }, [load, closeDialog]);

  const onCallLead = useCallback(async (lead: Lead) => {
    try {
      await dialLead(lead);
    } catch {
      // Dialer not available; nothing to do.
    }
  }, []);

  const pending = Math.max(0, todayCalls - todaySynced);

  return (
    <View style={styles.container}>
      {dialog ? <AppDialog visible {...dialog} /> : null}
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.spacing.lg }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load('refresh')}
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
          />
        }
      >
        {/* Brand header (kept as is) */}
        <View style={styles.hero}>
          {workspaceLogo ? (
            <>
              <View style={styles.workspaceLogoCard}>
                <Image source={{ uri: workspaceLogo }} style={styles.workspaceLogo} resizeMode="contain" />
              </View>
              {workspaceName ? <Text style={styles.workspaceName}>{workspaceName}</Text> : null}
              <View style={styles.poweredBy}>
                <Text style={styles.poweredByText}>Powered by</Text>
                <Image
                  source={require('../../assets/logo_gaincafe.png')}
                  style={styles.poweredByLogo}
                  resizeMode="contain"
                />
              </View>
            </>
          ) : (
            <>
              <View style={styles.iconWrap}>
                <Image
                  source={require('../../assets/logo_gaincafe.png')}
                  style={styles.logoImage}
                  resizeMode="contain"
                />
              </View>
              {workspaceName ? <Text style={styles.workspaceName}>{workspaceName}</Text> : null}
              <Text style={styles.subtitle}>Leads, calls & CRM sync</Text>
            </>
          )}
        </View>

        {callSyncMissing || leadsMissing ? (
          <View style={[styles.card, styles.warnCard]}>
            <Icon name="alert-outline" size={22} color={theme.colors.error} />
            <Text style={styles.cardText}>
              {callSyncMissing ? 'Call Sync is not enabled for this workspace, so calls will not upload. ' : ''}
              {leadsMissing ? 'Patient Enquiries is not enabled, so the Leads list will be empty. ' : ''}
              Ask your admin to enable it in the Control Panel, then sign out and in again.
            </Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : (
          <>
            {/* Today */}
            <Text style={styles.sectionTitle}>Today</Text>
            <View style={styles.statsRow}>
              <StatTile icon="phone-outline" value={String(todayCalls)} label={allCallSync ? 'Calls' : 'Lead calls'} color={theme.colors.primary} />
              <StatTile icon="cloud-check-outline" value={String(todaySynced)} label="Synced" color={theme.colors.success} />
              <StatTile icon="cloud-upload-outline" value={String(pending)} label="Pending" color="#D97706" />
            </View>

            {/* Sync row */}
            <View style={styles.syncRow}>
              <View style={styles.syncText}>
                <Text style={styles.syncLabel}>Last sync</Text>
                <Text style={styles.syncValue}>{lastSyncMs ? new Date(lastSyncMs).toLocaleString() : 'never'}</Text>
              </View>
              <TouchableOpacity
                style={[styles.syncButton, syncing && styles.buttonDisabled]}
                onPress={onSyncNow}
                disabled={syncing}
              >
                {syncing ? (
                  <ActivityIndicator color={theme.colors.textOnPrimary} size="small" />
                ) : (
                  <>
                    <Icon name="cloud-upload-outline" size={18} color={theme.colors.textOnPrimary} />
                    <Text style={styles.syncButtonText}>Sync now</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* Permission nudge */}
            {hasCallPermission === false ? (
              <TouchableOpacity style={[styles.card, styles.nudgeCard]} onPress={() => navigation.navigate('CallLogs')}>
                <Icon name="shield-alert-outline" size={22} color={theme.colors.primary} />
                <Text style={styles.cardText}>
                  Call log access is not allowed yet. Open <Text style={styles.bold}>Call logs</Text> and tap Grant permissions so calls can be counted and synced.
                </Text>
                <Icon name="chevron-right" size={22} color={theme.colors.tabInactive} />
              </TouchableOpacity>
            ) : null}

            {/* Follow-ups due */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Follow-ups due</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Leads')}>
                <Text style={styles.link}>All leads</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.listCard}>
              {followUps.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Icon name="calendar-check-outline" size={20} color={theme.colors.tabInactive} />
                  <Text style={styles.emptyText}>No follow-ups due today.</Text>
                </View>
              ) : (
                followUps.map((lead, i) => {
                  const status = leadStatusMeta(lead.status);
                  const when = formatFollowUp(lead.follow_up_date);
                  return (
                    <TouchableOpacity
                      key={String(lead.id)}
                      style={[styles.listRow, i < followUps.length - 1 && styles.listRowBorder]}
                      onPress={() => onCallLead(lead)}
                    >
                      <View style={[styles.rowDot, { backgroundColor: status.fg }]} />
                      <View style={styles.rowText}>
                        <Text style={styles.rowTitle} numberOfLines={1}>{(lead.name || '').trim() || lead.phone || 'Lead'}</Text>
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          {when}{lead.treatment ? ` · ${lead.treatment}` : ''}
                        </Text>
                      </View>
                      <View style={styles.rowCall}>
                        <Icon name="phone" size={18} color={theme.colors.textOnPrimary} />
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            {/* Recent calls */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Recent {allCallSync ? 'calls' : 'lead calls'}</Text>
              <TouchableOpacity onPress={() => navigation.navigate('CallLogs')}>
                <Text style={styles.link}>Call logs</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.listCard}>
              {recent.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Icon name="phone-off-outline" size={20} color={theme.colors.tabInactive} />
                  <Text style={styles.emptyText}>
                    {hasCallPermission === false ? 'Allow call log access to see calls here.' : 'No calls with leads yet.'}
                  </Text>
                </View>
              ) : (
                recent.map((c, i) => {
                  const dir = directionIcon(c.direction);
                  const status = c.leadStatus ? leadStatusMeta(c.leadStatus) : null;
                  return (
                    <View key={c.id} style={[styles.listRow, i < recent.length - 1 && styles.listRowBorder]}>
                      <Icon name={dir.name} size={20} color={dir.color} />
                      <View style={styles.rowText}>
                        <Text style={styles.rowTitle} numberOfLines={1}>{c.name}</Text>
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          {formatTime(c.timeMs)} · {formatDuration(c.duration)}
                          {status ? ` · ${status.short}` : ''}
                        </Text>
                      </View>
                      <View style={[styles.syncPill, c.synced ? styles.syncPillOn : styles.syncPillOff]}>
                        <Icon
                          name={c.synced ? 'check' : 'clock-outline'}
                          size={12}
                          color={c.synced ? theme.colors.success : '#D97706'}
                        />
                        <Text style={[styles.syncPillText, { color: c.synced ? theme.colors.success : '#D97706' }]}>
                          {c.synced ? 'Synced' : 'Pending'}
                        </Text>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundSecondary,
  },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  hero: {
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  iconWrap: {
    width: 260,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.sm,
  },
  logoImage: {
    width: 260,
    height: 52,
  },
  workspaceLogoCard: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    marginBottom: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  workspaceLogo: {
    width: 180,
    height: 90,
  },
  workspaceName: {
    fontSize: 20,
    fontWeight: '800',
    color: theme.colors.text,
    letterSpacing: -0.3,
    marginTop: theme.spacing.xs,
  },
  poweredBy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: theme.spacing.sm,
  },
  poweredByText: {
    fontSize: 12,
    color: theme.colors.tabInactive,
  },
  poweredByLogo: {
    width: 90,
    height: 18,
  },
  subtitle: {
    fontSize: 16,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.xs,
  },
  loadingBox: {
    paddingVertical: theme.spacing.xl,
    alignItems: 'center',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: theme.spacing.lg,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  link: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  statsRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  statTile: {
    flex: 1,
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    ...theme.shadows.sm,
  },
  statIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.sm,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '800',
    color: theme.colors.text,
  },
  statLabel: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    marginTop: theme.spacing.sm,
    gap: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  syncText: {
    flex: 1,
  },
  syncLabel: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  syncValue: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.text,
    marginTop: 2,
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
    borderRadius: theme.radius.md,
  },
  syncButtonText: {
    color: theme.colors.textOnPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: theme.colors.white,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    gap: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  warnCard: {
    marginBottom: theme.spacing.md,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  nudgeCard: {
    marginTop: theme.spacing.sm,
    alignItems: 'center',
  },
  cardText: {
    flex: 1,
    fontSize: 14,
    color: theme.colors.textSecondary,
    lineHeight: 20,
  },
  bold: {
    fontWeight: '700',
    color: theme.colors.text,
  },
  listCard: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    overflow: 'hidden',
    ...theme.shadows.sm,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 4,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 4,
  },
  listRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.cardBorder,
  },
  rowDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.text,
  },
  rowMeta: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  rowCall: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
    borderWidth: 1,
  },
  syncPillOn: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  syncPillOff: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  syncPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  emptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
  },
  emptyText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
  },
});
