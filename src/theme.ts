/**
 * App theme – orange + white
 */
export const theme = {
  colors: {
    primary: '#F97316',
    primaryDark: '#EA580C',
    primaryLight: '#FDBA74',
    white: '#FFFFFF',
    background: '#FFFFFF',
    backgroundSecondary: '#FFF7ED',
    card: '#FFFFFF',
    cardBorder: '#FFEDD5',
    text: '#1C1917',
    textSecondary: '#78716C',
    textOnPrimary: '#FFFFFF',
    tabInactive: '#A8A29E',
    error: '#DC2626',
    success: '#16A34A',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    full: 9999,
  },
  shadows: {
    sm: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 2,
    },
    md: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
      elevation: 4,
    },
  },
} as const;
