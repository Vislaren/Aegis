/**
 * Design tokens. Text/background pairs meet WCAG 2.2 AA (4.5:1) or better; status colors are
 * always paired with an icon and a word so meaning never relies on color alone.
 */
export const colors = {
  background: '#FFFFFF',
  surface: '#F5F7FA',
  border: '#C9D1DB',
  text: '#14202E',
  textMuted: '#4A5868',
  primary: '#0B5CAD',
  onPrimary: '#FFFFFF',
  danger: '#A4161A',
  onDanger: '#FFFFFF',
  focus: '#F2A900',
  status: {
    info: { fg: '#0B4F8A', bg: '#E6F0FA', icon: 'ℹ' },
    success: { fg: '#1E5E2B', bg: '#E7F4EA', icon: '✓' },
    warning: { fg: '#6B4A00', bg: '#FFF4D6', icon: '!' },
    danger: { fg: '#8A1116', bg: '#FCE8E9', icon: '✕' },
    neutral: { fg: '#2F3B4A', bg: '#EEF1F5', icon: '•' },
  },
} as const;

export type StatusTone = keyof typeof colors.status;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const typography = {
  title: { fontSize: 24, fontWeight: '700' as const, lineHeight: 30 },
  heading: { fontSize: 18, fontWeight: '600' as const, lineHeight: 24 },
  body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 22 },
  label: { fontSize: 14, fontWeight: '600' as const, lineHeight: 20 },
  caption: { fontSize: 13, fontWeight: '400' as const, lineHeight: 18 },
} as const;

/** Minimum interactive size (WCAG 2.5.8 / platform guidance), larger for driver actions. */
export const touchTarget = { minimum: 48, driver: 64 } as const;
