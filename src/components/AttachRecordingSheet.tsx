import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import CallLogs from 'react-native-call-log';
import type { CallLog } from 'react-native-call-log';
import { enrichCallLogsWithContactNames } from '../services/callLogNames';
import { getAllCallSyncEnabled } from '../services/appSettings';
import { findLeadForCall, getLeadPhoneIndex, phoneKey, type LeadPhoneIndex } from '../services/leadIndex';
import { pushSingleCallToPortal, setLastSyncedAt, toCalledAt } from '../services/portal';
import { buildRecordingExternalId, callTimeMs } from '../services/recordings';
import { deleteSharedFile, formatFileSize, type SharedFile } from '../services/shareReceiver';
import { leadStatusMeta } from '../services/crm';
import { AppDialog, type AppDialogProps } from './AppDialog';
import { theme } from '../theme';

type DialogState = Omit<AppDialogProps, 'visible'>;

const CANDIDATE_LIMIT = 10;
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

interface Candidate {
  call: CallLog;
  title: string;
  phone: string;
  timeMs: number;
  leadStatus?: string;
  nameMatch: boolean;
}

function formatWhen(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Phone numbers (10+ digits) that appear in the shared file's name, as last-10-digit keys. */
function phoneKeysInName(name: string): Set<string> {
  const keys = new Set<string>();
  const matches = name.replace(/[\s()+-]/g, '').match(/\d{10,13}/g) ?? [];
  matches.forEach((m) => keys.add(phoneKey(m)));
  return keys;
}

export function AttachRecordingSheet({ file, onDone }: { file: SharedFile; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (Platform.OS !== 'android') {
          setError('Recordings can only be attached on Android.');
          return;
        }
        const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CALL_LOG);
        if (!granted) {
          setError('Call log access is not allowed yet. Open the Call logs tab, tap "Grant permissions", then share the recording again.');
          return;
        }
        const [logs, index, allCalls] = await Promise.all([
          CallLogs.load(100),
          getLeadPhoneIndex(),
          getAllCallSyncEnabled(),
        ]);
        const enriched = await enrichCallLogsWithContactNames(logs);
        const cutoff = Date.now() - LOOKBACK_MS;
        const nameKeys = phoneKeysInName(file.name);
        const list: Candidate[] = enriched
          .filter((c) => callTimeMs(c) >= cutoff)
          .filter((c) => allCalls || !!findLeadForCall(index as LeadPhoneIndex | null, c))
          .map((c) => {
            const lead = findLeadForCall(index, c);
            const phone = c.formattedNumber || c.phoneNumber || '';
            const key = phoneKey(c.phoneNumber || c.formattedNumber);
            return {
              call: c,
              title: lead?.name || (c.name || '').trim() || phone,
              phone,
              timeMs: callTimeMs(c),
              leadStatus: lead?.status,
              nameMatch: !!key && nameKeys.has(key),
            };
          })
          .sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || b.timeMs - a.timeMs)
          .slice(0, CANDIDATE_LIMIT);
        if (!mounted) return;
        setCandidates(list);
        setSelectedId(list[0]?.call.id ?? null);
        if (list.length === 0) {
          setError(allCalls
            ? 'No calls in the last 3 days to attach this recording to.'
            : 'No calls with CRM leads in the last 3 days. Call a lead first, or turn on "All call sync" in Settings.');
        }
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : 'Could not load calls.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [file]);

  const selected = useMemo(
    () => candidates.find((c) => c.call.id === selectedId) ?? null,
    [candidates, selectedId]
  );

  const discard = useCallback(async () => {
    await deleteSharedFile(file.path);
    onDone();
  }, [file.path, onDone]);

  const upload = useCallback(async () => {
    if (!selected) return;
    setUploading(true);
    setDialog({ title: 'Uploading recording…', message: `Attaching to ${selected.title}.`, loading: true });
    try {
      const call = selected.call;
      const ts = callTimeMs(call);
      const result = await pushSingleCallToPortal(
        call,
        {
          recordingsByCallId: {
            [call.id]: [
              {
                recording_url: `file://${file.path}`,
                recording_external_id: buildRecordingExternalId(call, file.name, ts),
                duration_seconds: call.duration > 0 ? call.duration : undefined,
                source: 'mobile_app',
                recorded_at: toCalledAt(call),
              },
            ],
          },
        },
        'manual'
      );
      if (result.success) {
        await setLastSyncedAt(Date.now());
        await deleteSharedFile(file.path);
        setDialog({
          tone: 'success',
          icon: 'cloud-check-outline',
          title: 'Recording uploaded',
          message: `${file.name} is now attached to ${selected.title} in the CRM.`,
          primaryLabel: 'Done',
          onPrimary: () => {
            setDialog(null);
            onDone();
          },
        });
      } else {
        setDialog({
          tone: 'error',
          title: 'Upload failed',
          message: result.message,
          primaryLabel: 'OK',
          onPrimary: () => setDialog(null),
        });
      }
    } catch (e) {
      setDialog({
        tone: 'error',
        title: 'Upload failed',
        message: e instanceof Error ? e.message : 'Unknown error',
        primaryLabel: 'OK',
        onPrimary: () => setDialog(null),
      });
    } finally {
      setUploading(false);
    }
  }, [selected, file, onDone]);

  return (
    <Modal visible animationType="slide" onRequestClose={uploading ? undefined : discard}>
      <View style={[styles.container, { paddingTop: insets.top + theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.md }]}>
        {dialog ? <AppDialog visible {...dialog} /> : null}

        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Icon name="microphone-outline" size={24} color={theme.colors.primary} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.title}>Attach recording</Text>
            <Text style={styles.subtitle} numberOfLines={2}>
              {file.name}{file.size ? ` · ${formatFileSize(file.size)}` : ''}
            </Text>
          </View>
        </View>

        <Text style={styles.sectionLabel}>Which call is this recording from?</Text>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Icon name="alert-circle-outline" size={20} color={theme.colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {candidates.map((c) => {
              const active = c.call.id === selectedId;
              const status = c.leadStatus ? leadStatusMeta(c.leadStatus) : null;
              return (
                <TouchableOpacity
                  key={c.call.id}
                  style={[styles.row, active && styles.rowActive]}
                  onPress={() => setSelectedId(c.call.id)}
                  disabled={uploading}
                >
                  <Icon
                    name={active ? 'radiobox-marked' : 'radiobox-blank'}
                    size={22}
                    color={active ? theme.colors.primary : theme.colors.tabInactive}
                  />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{c.title}</Text>
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {c.phone} · {formatWhen(c.timeMs)} · {formatDuration(c.call.duration)}
                    </Text>
                  </View>
                  {status ? (
                    <View style={[styles.badge, { backgroundColor: status.bg }]}>
                      <Text style={[styles.badgeText, { color: status.fg }]}>{status.short}</Text>
                    </View>
                  ) : null}
                  {c.nameMatch ? (
                    <Icon name="link-variant" size={18} color={theme.colors.success} />
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        <View style={styles.footer}>
          <TouchableOpacity style={styles.secondary} onPress={discard} disabled={uploading}>
            <Text style={styles.secondaryText}>Discard</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primary, (!selected || uploading) && styles.disabled]}
            onPress={upload}
            disabled={!selected || uploading}
          >
            {uploading ? (
              <ActivityIndicator color={theme.colors.textOnPrimary} size="small" />
            ) : (
              <>
                <Icon name="cloud-upload-outline" size={20} color={theme.colors.textOnPrimary} />
                <Text style={styles.primaryText}>Upload to CRM</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundSecondary,
    paddingHorizontal: theme.spacing.lg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    marginBottom: theme.spacing.lg,
  },
  headerIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: theme.colors.text,
  },
  subtitle: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm + 4,
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
  },
  rowActive: {
    borderColor: theme.colors.primary,
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
  badge: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.full,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
  },
  errorText: {
    flex: 1,
    color: theme.colors.error,
    fontSize: 14,
    lineHeight: 20,
  },
  footer: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
  },
  secondary: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.white,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
  },
  secondaryText: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.textSecondary,
  },
  primary: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
  },
  primaryText: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.textOnPrimary,
  },
  disabled: {
    opacity: 0.6,
  },
});
