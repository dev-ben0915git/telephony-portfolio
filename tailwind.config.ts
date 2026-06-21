import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#070b13',
          soft: '#0b1220',
          card: '#0d1829',
          line: '#132136',
        },
        accent: {
          DEFAULT: '#00d4ff',
          soft: '#6ae4ff',
          deep: '#0077aa',
          glow: 'rgba(0, 212, 255, 0.35)',
        },
        tech: {
          yellow: '#ffcc00',
          green: '#35e6a8',
          purple: '#a07cff',
          orange: '#ff8a3d',
          pink: '#ff6fae',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'Fira Code',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      boxShadow: {
        glow: '0 0 30px rgba(0, 212, 255, 0.25)',
        card: '0 8px 30px rgba(0, 0, 0, 0.45)',
      },
      backgroundImage: {
        'grid-tech':
          'linear-gradient(rgba(0,212,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.06) 1px, transparent 1px)',
        'grid-subtle':
          'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
        'radial-spot':
          'radial-gradient(600px circle at 50% 0%, rgba(0,212,255,0.18), transparent 60%)',
      },
      backgroundSize: {
        grid: '32px 32px',
      },
      keyframes: {
        pulseRing: {
          '0%': { transform: 'scale(0.6)', opacity: '0.9' },
          '80%, 100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.2' },
        },
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        drawLine: {
          '0%': { strokeDashoffset: '1000' },
          '100%': { strokeDashoffset: '0' },
        },
      },
      animation: {
        pulseRing: 'pulseRing 2.2s cubic-bezier(0.2, 0.8, 0.2, 1) infinite',
        float: 'float 4s ease-in-out infinite',
        shimmer: 'shimmer 2.8s linear infinite',
        blink: 'blink 1.1s ease-in-out infinite',
        fadeUp: 'fadeUp 0.7s ease-out both',
        drawLine: 'drawLine 2s ease-out forwards',
      },
    },
  },
  plugins: [],
};

export default config;
