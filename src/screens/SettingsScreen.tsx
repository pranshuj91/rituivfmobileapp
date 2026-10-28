import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { getDeviceInfo, getLastSyncedAt, setDeviceInfo } from '../services/portal';
import { CRM_API_BASE_URL, featureMissing, logout, useSession } from '../services/auth';
import {
  clearLeadPhoneIndex,
  getLeadPhoneIndex,
  refreshLeadPhoneIndex,
} from '../services/leadIndex';
import { runScheduledSync } from '../services/syncSchedule';
import { getAllCallSyncEnabled, setAllCallSyncEnabled } from '../services/appSettings';
import { AppDialog, type AppDialogProps } from '../components/AppDialog';
import { theme } from '../theme';

type DialogState = Omit<AppDialogProps, 'visible'>;

const APP_VERSION = '1.0';
const CRM_HOST = CRM_API_BASE_URL.replace(/^https?:\/\//, '').split('/')[0];

/**
 * The device name/phone fields are hidden: the device is identified by the
 * logged-in agent. The code stays so it can be re-enabled per customer.
 */
const SHOW_DEVICE_SECTION = false;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}

function formatTime(ms: number | null): string {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString();
}

function Chip({ label, on }: { label: string; on: boolean }) {
  return (
    <View style={[styles.chip, on ? styles.chipOn : styles.chipOff]}>
      <Icon
        name={on ? 'check-circle' : 'close-circle'}
        size={14}
        color={on ? theme.colors.success : theme.colors.error}
      />
      <Text style={[styles.chipText, on ? styles.chipTextOn : styles.chipTextOff]}>{label}</Text>
    </View>
  );
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIcon}>
        <Icon name={icon} size={18} color={theme.colors.primary} />
      </View>
      <View style={styles.detailText}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue} numberOfLines={2}>{value}</Text>
      </View>
    </View>
  );
}

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [devicePhone, setDevicePhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [lastSyncMs, setLastSyncMs] = useState<number | null>(null);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshingLeads, setRefreshingLeads] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const [allCallSync, setAllCallSync] = useState(false);

  useEffect(() => {
    getAllCallSyncEnabled().then(setAllCallSync);
  }, []);

  const onToggleAllCallSync = useCallback(async (value: boolean) => {
    setAllCallSync(value);
    await setAllCallSyncEnabled(value);
  }, []);

  const refreshStatus = useCallback(async () => {
    const [last, index] = await Promise.all([
      getLastSyncedAt(),
      getLeadPhoneIndex({ maxAgeMs: Number.MAX_SAFE_INTEGER }),
    ]);
    setLastSyncMs(last);
    setLeadCount(index ? Object.keys(index.byLast10).length : null);
  }, []);

  useEffect(() => {
    let mounted = true;
    getDeviceInfo()
      .then((info) => {
        if (!mounted) return;
        setDeviceName(info.deviceName);
        setDevicePhone(info.devicePhone);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshStatus();
    }, [refreshStatus])
  );

  const onSave = useCallback(async () => {
    Keyboard.dismiss();
    setSaving(true);
    setSaved(false);
    try {
      await setDeviceInfo(deviceName, devicePhone);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }, [deviceName, devicePhone]);

  const onSyncNow = useCallback(async () => {
    setSyncing(true);
    setDialog({
      title: 'Syncing…',
      message: 'Checking new calls with CRM leads and sending them.',
      loading: true,
    });
    try {
      const result = await runScheduledSync();
      await refreshStatus();
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
      setDialog({
        tone,
        icon: result.status === 'synced' ? 'cloud-check-outline' : undefined,
        title,
        message: result.message,
        primaryLabel: 'OK',
        onPrimary: closeDialog,
      });
    } finally {
      setSyncing(false);
    }
  }, [refreshStatus, closeDialog]);

  const onRefreshLeads = useCallback(async () => {
    setRefreshingLeads(true);
    setDialog({
      title: 'Refreshing leads…',
      message: 'Loading lead numbers from the CRM.',
      loading: true,
    });
    try {
      const index = await refreshLeadPhoneIndex();
      await refreshStatus();
      const count = index ? Object.keys(index.byLast10).length : 0;
      setDialog(
        index
          ? {
              tone: 'success',
              icon: 'account-check-outline',
              title: 'Leads refreshed',
              message: `${count} lead number${count === 1 ? '' : 's'} loaded from the CRM. Only calls with these numbers are shown and synced.`,
              primaryLabel: 'OK',
              onPrimary: closeDialog,
            }
          : {
              tone: 'error',
              title: 'Could not refresh',
              message: 'Check your internet connection and try again.',
              primaryLabel: 'OK',
              onPrimary: closeDialog,
            }
      );
    } finally {
      setRefreshingLeads(false);
    }
  }, [refreshStatus, closeDialog]);

  const performLogout = useCallback(async () => {
    setLoggingOut(true);
    setDialog({ title: 'Signing out…', loading: true });
    try {
      await logout();
      await clearLeadPhoneIndex();
      // The session listener in App switches to the login screen.
    } finally {
      setLoggingOut(false);
      setDialog(null);
    }
  }, []);

  const onLogout = useCallback(() => {
    setDialog({
      tone: 'warning',
      icon: 'logout',
      title: 'Sign out?',
      message: 'You will need your Gaincafe CRM email and password to sign in again on this phone.',
      primaryLabel: 'Sign out',
      primaryDestructive: true,
      onPrimary: performLogout,
      secondaryLabel: 'Cancel',
      onSecondary: closeDialog,
    });
  }, [performLogout, closeDialog]);

  if (loading) {
    return (
      <View style={[styles.container, styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  const userName = (session?.user?.name || '').trim();
  const userEmail = (session?.user?.email || '').trim();
  const workspaceName = (session?.workspace?.name || '').trim();
  const workspaceLogo = !logoFailed ? session?.workspace?.logoUrl : undefined;
  const workspaceKeys = session?.workspace?.rawKeys ?? [];
  const callSyncOn = !featureMissing(session, 'call-sync');
  const leadsOn = !featureMissing(session, 'patient-enquiries');
  const defaultDeviceName = userName || userEmail;

  return (
    <View style={styles.container}>
      {dialog ? <AppDialog visible {...dialog} /> : null}
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + theme.spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header: brand logo centred, workspace name below */}
        <View style={styles.header}>
          {workspaceLogo ? (
            <View style={styles.headerLogoCard}>
              <Image
                source={{ uri: workspaceLogo }}
                style={styles.headerLogoRemote}
                resizeMode="contain"
                onError={() => setLogoFailed(true)}
              />
            </View>
          ) : (
            <Image
              source={require('../../assets/logo_gaincafe.png')}
              style={styles.headerLogo}
              resizeMode="contain"
            />
          )}
          {workspaceName ? <Text style={styles.workspaceName}>{workspaceName}</Text> : null}
          <View style={styles.chipsRow}>
            <Chip label="Call Sync" on={callSyncOn} />
            <Chip label="Leads" on={leadsOn} />
          </View>
        </View>

        {/* Account details */}
        <View style={styles.card}>
          <View style={styles.accountTop}>
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarText}>{initialsOf(userName || userEmail || '?')}</Text>
            </View>
            <View style={styles.accountText}>
              <Text style={styles.accountName} numberOfLines={1}>{userName || 'Signed in'}</Text>
              {session?.role ? (
                <Text style={styles.accountRole}>{session.role}</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.divider} />
          {userEmail ? <DetailRow icon="email-outline" label="Email" value={userEmail} /> : null}
          <DetailRow icon="domain" label="Workspace" value={workspaceName || session?.workspace?.id || '-'} />
          <DetailRow icon="clock-outline" label="Last sync" value={formatTime(lastSyncMs)} />
          <DetailRow
            icon="account-multiple-outline"
            label="Lead numbers cached"
            value={leadCount == null ? 'not loaded' : String(leadCount)}
          />
          <DetailRow
            icon={workspaceLogo ? 'image-outline' : 'image-off-outline'}
            label="Brand logo"
            value={
              workspaceLogo
                ? 'Provided by the CRM workspace'
                : `Not in CRM workspace data (fields: ${workspaceKeys.length ? workspaceKeys.join(', ') : 'none'})`
            }
          />
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.secondaryButton, refreshingLeads && styles.buttonDisabled]}
              onPress={onRefreshLeads}
              disabled={refreshingLeads || syncing}
            >
              {refreshingLeads ? (
                <ActivityIndicator color={theme.colors.primary} size="small" />
              ) : (
                <>
                  <Icon name="refresh" size={18} color={theme.colors.primary} />
                  <Text style={styles.secondaryButtonText}>Refresh leads</Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primaryButton, syncing && styles.buttonDisabled]}
              onPress={onSyncNow}
              disabled={syncing || refreshingLeads}
            >
              {syncing ? (
                <ActivityIndicator color={theme.colors.textOnPrimary} size="small" />
              ) : (
                <>
                  <Icon name="cloud-upload-outline" size={18} color={theme.colors.textOnPrimary} />
                  <Text style={styles.primaryButtonText}>Sync now</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Call sync mode */}
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleIcon}>
              <Icon name="sync" size={22} color={theme.colors.primary} />
            </View>
            <View style={styles.toggleText}>
              <Text style={styles.toggleTitle}>All call sync</Text>
              <Text style={styles.toggleHint}>
                {allCallSync ? 'On · every call on this phone is synced' : 'Off · only calls with CRM leads are synced'}
              </Text>
            </View>
            <Switch
              value={allCallSync}
              onValueChange={onToggleAllCallSync}
              trackColor={{ false: '#E7E5E4', true: theme.colors.primaryLight }}
              thumbColor={allCallSync ? theme.colors.primary : '#FAFAF9'}
              ios_backgroundColor="#E7E5E4"
            />
          </View>
          <View style={styles.modeBox}>
            <View style={[styles.modeRow, allCallSync && styles.modeRowActive]}>
              <Icon
                name={allCallSync ? 'check-circle' : 'circle-outline'}
                size={18}
                color={allCallSync ? theme.colors.primary : theme.colors.tabInactive}
              />
              <View style={styles.modeText}>
                <Text style={[styles.modeTitle, allCallSync && styles.modeTitleActive]}>On</Text>
                <Text style={styles.modeHint}>
                  Every incoming and outgoing call is uploaded with its recording. Unknown numbers become new leads in the CRM.
                </Text>
              </View>
            </View>
            <View style={[styles.modeRow, !allCallSync && styles.modeRowActive]}>
              <Icon
                name={!allCallSync ? 'check-circle' : 'circle-outline'}
                size={18}
                color={!allCallSync ? theme.colors.primary : theme.colors.tabInactive}
              />
              <View style={styles.modeText}>
                <Text style={[styles.modeTitle, !allCallSync && styles.modeTitleActive]}>Off</Text>
                <Text style={styles.modeHint}>
                  Only calls with numbers that already exist in the Leads list are uploaded. Other calls stay on the phone.
                </Text>
              </View>
            </View>
          </View>
        </View>

        {SHOW_DEVICE_SECTION ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>This phone</Text>
            <Text style={styles.label}>Device name</Text>
            <Text style={styles.hint}>
              Optional. Leave empty to use your login name{defaultDeviceName ? ` (${defaultDeviceName})` : ''}.
            </Text>
            <TextInput
              style={styles.input}
              value={deviceName}
              onChangeText={(v) => {
                setDeviceName(v);
                setSaved(false);
              }}
              placeholder={defaultDeviceName || 'e.g. Reception Phone'}
              placeholderTextColor={theme.colors.tabInactive}
            />
            <Text style={styles.label}>Device phone number</Text>
            <Text style={styles.hint}>Optional. The SIM number of this phone.</Text>
            <TextInput
              style={styles.input}
              value={devicePhone}
              onChangeText={(v) => {
                setDevicePhone(v);
                setSaved(false);
              }}
              placeholder="+91..."
              placeholderTextColor={theme.colors.tabInactive}
              keyboardType="phone-pad"
            />
            <TouchableOpacity
              style={[styles.primaryButton, saving && styles.buttonDisabled]}
              onPress={onSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={theme.colors.textOnPrimary} size="small" />
              ) : (
                <>
                  <Icon name="content-save-outline" size={18} color={theme.colors.textOnPrimary} />
                  <Text style={styles.primaryButtonText}>Save</Text>
                </>
              )}
            </TouchableOpacity>
            {saved && (
              <View style={styles.successRow}>
                <Icon name="check-circle" size={18} color={theme.colors.success} />
                <Text style={styles.successText}>Saved.</Text>
              </View>
            )}
          </View>
        ) : null}

        <Text style={styles.about}>
          Gaincafe CRM app v{APP_VERSION} · {CRM_HOST}
        </Text>
      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + theme.spacing.md }]}>
        <TouchableOpacity
          style={[styles.logoutButton, loggingOut && styles.buttonDisabled]}
          onPress={onLogout}
          disabled={loggingOut}
        >
          {loggingOut ? (
            <ActivityIndicator color={theme.colors.error} size="small" />
          ) : (
            <>
              <Icon name="logout" size={20} color={theme.colors.error} />
              <Text style={styles.logoutText}>Sign out</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
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
    paddingBottom: theme.spacing.lg,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  headerLogo: {
    width: 220,
    height: 46,
  },
  headerLogoCard: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    ...theme.shadows.sm,
  },
  headerLogoRemote: {
    width: 160,
    height: 80,
  },
  workspaceName: {
    fontSize: 20,
    fontWeight: '800',
    color: theme.colors.text,
    letterSpacing: -0.3,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
  chipsRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: 4,
    borderWidth: 1,
  },
  chipOn: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  chipOff: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '700',
  },
  chipTextOn: {
    color: theme.colors.success,
  },
  chipTextOff: {
    color: theme.colors.error,
  },
  card: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    marginBottom: theme.spacing.md,
    ...theme.shadows.sm,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  accountTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  avatarCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: theme.colors.textOnPrimary,
    fontSize: 19,
    fontWeight: '800',
  },
  accountText: {
    flex: 1,
  },
  accountName: {
    fontSize: 18,
    fontWeight: '800',
    color: theme.colors.text,
  },
  accountRole: {
    fontSize: 13,
    color: theme.colors.primaryDark,
    fontWeight: '600',
    textTransform: 'capitalize',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.cardBorder,
    marginVertical: theme.spacing.md,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm + 4,
    marginBottom: theme.spacing.sm + 4,
  },
  detailIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.backgroundSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailText: {
    flex: 1,
  },
  detailLabel: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  detailValue: {
    fontSize: 15,
    color: theme.colors.text,
    fontWeight: '600',
    marginTop: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 4,
  },
  toggleIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.backgroundSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleText: {
    flex: 1,
  },
  toggleTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: theme.colors.text,
  },
  toggleHint: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  modeBox: {
    marginTop: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
  },
  modeRowActive: {
    backgroundColor: theme.colors.backgroundSecondary,
  },
  modeText: {
    flex: 1,
  },
  modeTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.textSecondary,
  },
  modeTitleActive: {
    color: theme.colors.text,
  },
  modeHint: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    lineHeight: 17,
    marginTop: 2,
  },
  primaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.sm + 4,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    gap: theme.spacing.xs,
  },
  primaryButtonText: {
    color: theme.colors.textOnPrimary,
    fontSize: 15,
    fontWeight: '700',
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
    borderColor: theme.colors.primaryLight,
    gap: theme.spacing.xs,
  },
  secondaryButtonText: {
    color: theme.colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 2,
  },
  hint: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    lineHeight: 17,
    marginBottom: theme.spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 4,
    fontSize: 16,
    color: theme.colors.text,
    marginBottom: theme.spacing.md,
    backgroundColor: theme.colors.white,
  },
  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  successText: {
    fontSize: 14,
    color: theme.colors.success,
    fontWeight: '600',
  },
  about: {
    textAlign: 'center',
    fontSize: 12,
    color: theme.colors.tabInactive,
    marginTop: theme.spacing.xs,
  },
  footer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    backgroundColor: theme.colors.backgroundSecondary,
    borderTopWidth: 1,
    borderTopColor: theme.colors.cardBorder,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.error,
    backgroundColor: theme.colors.white,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    gap: theme.spacing.sm,
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.error,
  },
});
