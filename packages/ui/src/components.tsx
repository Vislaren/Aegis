import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { colors, spacing, touchTarget, typography, type StatusTone } from './tokens';

export function Screen({
  title,
  children,
  header,
}: {
  title: string;
  children: ReactNode;
  header?: ReactNode;
}) {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      <RNText accessibilityRole="header" style={styles.title}>
        {title}
      </RNText>
      {children}
    </ScrollView>
  );
}

export function Text({
  children,
  tone = 'default',
  variant = 'body',
}: {
  children: ReactNode;
  tone?: 'default' | 'muted';
  variant?: keyof typeof typography;
}) {
  return (
    <RNText
      style={[typography[variant], { color: tone === 'muted' ? colors.textMuted : colors.text }]}
    >
      {children}
    </RNText>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <RNText accessibilityRole="header" style={[typography.heading, styles.heading]}>
      {children}
    </RNText>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  /** Larger target for drivers, used only while the vehicle is stopped. */
  size?: 'regular' | 'driver';
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  size = 'regular',
  accessibilityHint,
}: ButtonProps) {
  const inactive = disabled || busy;
  const palette =
    variant === 'primary'
      ? { bg: colors.primary, fg: colors.onPrimary, border: colors.primary }
      : variant === 'danger'
        ? { bg: colors.danger, fg: colors.onDanger, border: colors.danger }
        : { bg: colors.background, fg: colors.primary, border: colors.primary };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => [
        styles.button,
        {
          minHeight: size === 'driver' ? touchTarget.driver : touchTarget.minimum,
          backgroundColor: palette.bg,
          borderColor: focused === true ? colors.focus : palette.border,
          opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <RNText style={[typography.label, { color: palette.fg }]}>{label}</RNText>
      )}
    </Pressable>
  );
}

export interface TextFieldProps extends Pick<
  TextInputProps,
  | 'value'
  | 'onChangeText'
  | 'keyboardType'
  | 'autoComplete'
  | 'secureTextEntry'
  | 'onSubmitEditing'
  | 'textContentType'
> {
  label: string;
  error?: string | null;
  hint?: string;
}

export function TextField({ label, error, hint, ...input }: TextFieldProps) {
  return (
    <View style={styles.field}>
      <RNText style={[typography.label, { color: colors.text }]} nativeID={`${label}-label`}>
        {label}
      </RNText>
      {hint === undefined ? null : (
        <RNText style={[typography.caption, { color: colors.textMuted }]}>{hint}</RNText>
      )}
      <TextInput
        {...input}
        accessibilityLabel={label}
        accessibilityLabelledBy={`${label}-label`}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, error ? { borderColor: colors.danger } : null]}
      />
      {error ? (
        <RNText
          accessibilityLiveRegion="polite"
          style={[typography.caption, { color: colors.danger }]}
        >
          {colors.status.danger.icon} {error}
        </RNText>
      ) : null}
    </View>
  );
}

/** Status message with icon + text + color. `live` announces changes to screen readers. */
export function Banner({
  tone,
  title,
  message,
  live = false,
}: {
  tone: StatusTone;
  title: string;
  message?: string;
  live?: boolean;
}) {
  const palette = colors.status[tone];
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLiveRegion={live ? 'polite' : 'none'}
      style={[styles.banner, { backgroundColor: palette.bg, borderColor: palette.fg }]}
    >
      <RNText style={[typography.label, { color: palette.fg }]}>
        {palette.icon} {title}
      </RNText>
      {message === undefined ? null : (
        <RNText style={[typography.body, { color: palette.fg }]}>{message}</RNText>
      )}
    </View>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  screenContent: {
    padding: spacing.md,
    gap: spacing.md,
    maxWidth: 960,
    width: '100%',
    alignSelf: 'center',
  },
  title: { ...typography.title, color: colors.text },
  heading: { color: colors.text, marginTop: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  button: {
    borderRadius: 8,
    borderWidth: 2,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: { gap: spacing.xs },
  input: {
    ...typography.body,
    minHeight: touchTarget.minimum,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    color: colors.text,
    backgroundColor: colors.background,
  },
  banner: {
    borderWidth: 1,
    borderLeftWidth: 6,
    borderRadius: 8,
    padding: spacing.md,
    gap: spacing.xs,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
});
