import React from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { theme } from '../theme';

export type DialogTone = 'info' | 'success' | 'error' | 'warning';

export interface AppDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  /** MaterialCommunityIcons name; defaults per tone */
  icon?: string;
  tone?: DialogTone;
  /** Shows a spinner instead of buttons (e.g. while syncing) */
  loading?: boolean;
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDestructive?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Back button / backdrop; defaults to onSecondary, then onPrimary */
  onRequestClose?: () => void;
}

const TONE_COLORS: Record<DialogTone, { fg: string; bg: string }> = {
  info: { fg: theme.colors.primary, bg: theme.colors.backgroundSecondary },
  success: { fg: theme.colors.success, bg: '#F0FDF4' },
  error: { fg: theme.colors.error, bg: '#FEF2F2' },
  warning: { fg: '#D97706', bg: '#FFFBEB' },
};

const TONE_ICONS: Record<DialogTone, string> = {
  info: 'information-outline',
  success: 'check-circle-outline',
  error: 'alert-circle-outline',
  warning: 'alert-outline',
};

export function AppDialog({
  visible,
  title,
  message,
  icon,
  tone = 'info',
  loading = false,
  primaryLabel = 'OK',
  onPrimary,
  primaryDestructive = false,
  secondaryLabel,
  onSecondary,
  onRequestClose,
}: AppDialogProps) {
  const colors = TONE_COLORS[tone];
  const close = onRequestClose ?? onSecondary ?? onPrimary ?? (() => undefined);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={loading ? undefined : close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={[styles.iconWrap, { backgroundColor: colors.bg }]}>
            {loading ? (
              <ActivityIndicator size="large" color={colors.fg} />
            ) : (
              <Icon name={icon ?? TONE_ICONS[tone]} size={34} color={colors.fg} />
            )}
          </View>
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}
          {!loading ? (
            <View style={styles.buttons}>
              {secondaryLabel ? (
                <TouchableOpacity style={styles.secondary} onPress={onSecondary}>
                  <Text style={styles.secondaryText}>{secondaryLabel}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[
                  styles.primary,
                  primaryDestructive && styles.primaryDestructive,
                  !secondaryLabel && styles.primaryFull,
                ]}
                onPress={onPrimary}
              >
                <Text style={styles.primaryText}>{primaryLabel}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(28, 25, 23, 0.55)',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  },
  card: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg + 4,
    padding: theme.spacing.lg,
    alignItems: 'center',
    ...theme.shadows.md,
  },
  iconWrap: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.md,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: theme.colors.text,
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
    marginTop: theme.spacing.sm,
  },
  buttons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.lg,
    alignSelf: 'stretch',
  },
  primary: {
    flex: 1,
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.sm + 6,
    borderRadius: theme.radius.md,
    alignItems: 'center',
  },
  primaryFull: {
    flex: 1,
  },
  primaryDestructive: {
    backgroundColor: theme.colors.error,
  },
  primaryText: {
    color: theme.colors.textOnPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  secondary: {
    flex: 1,
    backgroundColor: theme.colors.white,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    paddingVertical: theme.spacing.sm + 6,
    borderRadius: theme.radius.md,
    alignItems: 'center',
  },
  secondaryText: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
  },
});
