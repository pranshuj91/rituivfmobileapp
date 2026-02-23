import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { getPortalUrl, setPortalUrl } from '../services/portal';
import { theme } from '../theme';

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let mounted = true;
    getPortalUrl().then((u) => {
      if (mounted) setUrl(u);
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const onSave = useCallback(async () => {
    Keyboard.dismiss();
    setSaving(true);
    setSaved(false);
    try {
      await setPortalUrl(url);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }, [url]);

  if (loading) {
    return (
      <View style={[styles.container, styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + theme.spacing.lg }]}>
      <View style={styles.section}>
        <Text style={styles.label}>Portal API URL</Text>
        <Text style={styles.hint}>POST endpoint where call logs will be sent (JSON).</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="https://your-api.com/calls"
          placeholderTextColor={theme.colors.tabInactive}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TouchableOpacity
          style={[styles.button, saving && styles.buttonDisabled]}
          onPress={onSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={theme.colors.textOnPrimary} size="small" />
          ) : (
            <>
              <Icon name="content-save" size={20} color={theme.colors.textOnPrimary} />
              <Text style={styles.buttonText}>Save</Text>
            </>
          )}
        </TouchableOpacity>
        {saved && (
          <View style={styles.successRow}>
            <Icon name="check-circle" size={20} color={theme.colors.success} />
            <Text style={styles.successText}>Saved.</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.backgroundSecondary,
    paddingHorizontal: theme.spacing.lg,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  section: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    ...theme.shadows.sm,
  },
  label: {
    fontSize: 17,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  hint: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.md,
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
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    gap: theme.spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.textOnPrimary,
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
});
