import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { Logo } from '../components/Logo';
import { CRM_API_BASE_URL, login } from '../services/auth';
import { theme } from '../theme';

const CRM_HOST = CRM_API_BASE_URL.replace(/^https?:\/\//, '').split('/')[0];

export function LoginScreen() {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<'email' | 'password' | null>(null);

  const onSubmit = useCallback(async () => {
    Keyboard.dismiss();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      // useSession() in App re-renders into the main tabs.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  }, [email, password]);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingTop: insets.top + theme.spacing.xl, paddingBottom: insets.bottom + theme.spacing.lg },
        ]}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {/* Brand */}
        <View style={styles.brand}>
          <Logo width={230} height={46} />
          <Text style={styles.brandTagline}>Leads, calls & CRM sync</Text>
        </View>

        {/* Form, pushed towards the middle of the screen */}
        <View style={styles.formArea}>
          <View style={styles.card}>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sign in with your Gaincafe CRM agent account.</Text>

            <Text style={styles.label}>Email</Text>
            <View style={[styles.inputRow, focused === 'email' && styles.inputRowFocused]}>
              <Icon name="email-outline" size={20} color={theme.colors.tabInactive} />
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                onFocus={() => setFocused('email')}
                onBlur={() => setFocused(null)}
                placeholder="agent@company.com"
                placeholderTextColor={theme.colors.tabInactive}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="next"
                editable={!loading}
              />
            </View>

            <Text style={styles.label}>Password</Text>
            <View style={[styles.inputRow, focused === 'password' && styles.inputRowFocused]}>
              <Icon name="lock-outline" size={20} color={theme.colors.tabInactive} />
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                onFocus={() => setFocused('password')}
                onBlur={() => setFocused(null)}
                placeholder="Your password"
                placeholderTextColor={theme.colors.tabInactive}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="password"
                textContentType="password"
                returnKeyType="done"
                onSubmitEditing={onSubmit}
                editable={!loading}
              />
              <TouchableOpacity
                style={styles.eyeBtn}
                onPress={() => setShowPassword((v) => !v)}
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Icon
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={theme.colors.textSecondary}
                />
              </TouchableOpacity>
            </View>

            {error ? (
              <View style={styles.errorBox}>
                <Icon name="alert-circle-outline" size={18} color={theme.colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.button, !canSubmit && styles.buttonDisabled]}
              onPress={onSubmit}
              disabled={!canSubmit}
            >
              {loading ? (
                <ActivityIndicator color={theme.colors.textOnPrimary} size="small" />
              ) : (
                <>
                  <Text style={styles.buttonText}>Sign in</Text>
                  <Icon name="arrow-right" size={20} color={theme.colors.textOnPrimary} />
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.footer}>
            <Icon name="shield-lock-outline" size={14} color={theme.colors.tabInactive} />
            <Text style={styles.footerText}>Secure connection to {CRM_HOST}</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: theme.colors.backgroundSecondary,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.backgroundSecondary,
  },
  brand: {
    alignItems: 'center',
    paddingTop: theme.spacing.lg,
  },
  brandTagline: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.sm,
  },
  formArea: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: theme.spacing.xl,
  },
  card: {
    backgroundColor: theme.colors.white,
    borderRadius: theme.radius.lg + 4,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    ...theme.shadows.md,
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
    marginBottom: theme.spacing.lg,
    lineHeight: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.cardBorder,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    backgroundColor: theme.colors.white,
    marginBottom: theme.spacing.md,
  },
  inputRowFocused: {
    borderColor: theme.colors.primary,
  },
  input: {
    flex: 1,
    paddingVertical: theme.spacing.sm + 6,
    fontSize: 16,
    color: theme.colors.text,
  },
  eyeBtn: {
    padding: 4,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm + 4,
    marginBottom: theme.spacing.md,
  },
  errorText: {
    flex: 1,
    color: theme.colors.error,
    fontSize: 14,
    lineHeight: 20,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.textOnPrimary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: theme.spacing.lg,
  },
  footerText: {
    fontSize: 12,
    color: theme.colors.tabInactive,
  },
});
