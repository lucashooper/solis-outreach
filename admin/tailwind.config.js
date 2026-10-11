/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0c0c0e',
          raised: '#161618',
          overlay: '#1c1c20',
        },
        line: {
          DEFAULT: '#2a2a2e',
          strong: '#3a3a40',
        },
        ink: {
          DEFAULT: '#f4f4f5',
          muted: '#a1a1aa',
          faint: '#71717a',
        },
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#60a5fa',
          muted: '#1e3a5f',
          indigo: '#3b82f6',
        },
        'accent-hover': '#60a5fa',
        status: {
          pending: '#a1a1aa',
          queued: '#f59e0b',
          sent: '#3b82f6',
          replied: '#34d399',
        },
        slate: {
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#0c0c0e',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glass: '0 1px 0 rgba(255,255,255,0.04)',
        glow: 'none',
        raised: '0 1px 0 rgba(255,255,255,0.04), 0 16px 40px rgba(0,0,0,0.35)',
      },
      backgroundImage: {
        'solis-gradient': 'none',
        'card-shine': 'none',
      },
    },
  },
  plugins: [],
};
