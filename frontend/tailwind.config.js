/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Identidade UpDown Internet: azul #1A00A8, ciano #12BAEA, roxo #A40AE8.
        cyan: { 50: '#e8f8fe', 100: '#c9effc', 200: '#9be3f8', 300: '#5fd2f3', 400: '#12baea', 500: '#0ea3d0', 600: '#0b85ab', 700: '#0a6a88', 800: '#0b546c', 900: '#0b4559', 950: '#062b39' },
        sky: { 50: '#e8f8fe', 100: '#c9effc', 200: '#9be3f8', 300: '#5fd2f3', 400: '#3fc6ee', 500: '#12baea', 600: '#0b85ab', 700: '#0a6a88', 800: '#0b546c', 900: '#0b4559', 950: '#062b39' },
        violet: { 50: '#f8effe', 100: '#f0dcfd', 200: '#e4bffc', 300: '#d79cfa', 400: '#c874f8', 500: '#a40ae8', 600: '#8a08c4', 700: '#6f079e', 800: '#56077a', 900: '#3f065a', 950: '#29033d' },
        purple: { 50: '#f8effe', 100: '#f0dcfd', 200: '#e4bffc', 300: '#d79cfa', 400: '#c874f8', 500: '#a40ae8', 600: '#8a08c4', 700: '#6f079e', 800: '#56077a', 900: '#3f065a', 950: '#29033d' },
        indigo: { 50: '#eeecff', 100: '#dcd8ff', 200: '#b9b1ff', 300: '#958aff', 400: '#6b5cff', 500: '#3d22f0', 600: '#2a12e0', 700: '#1a00a8', 800: '#150086', 900: '#10006a', 950: '#0a0045' },
        slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#9ba3c0', 500: '#6a7096', 600: '#4a4a78', 700: '#302c5e', 800: '#1d1947', 900: '#110d36', 950: '#06031d' },
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        dark: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        display: ['Orbitron', 'Inter', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 9s linear infinite',
        'spin-slower': 'spin 16s linear infinite',
        'spin-rev': 'spinRev 12s linear infinite',
        'reveal': 'reveal 0.6s cubic-bezier(0.2, 0.7, 0.2, 1) both',
        'shimmer': 'shimmer 1.6s linear infinite',
        'glow': 'glow 2.4s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        spinRev: { '0%': { transform: 'rotate(360deg)' }, '100%': { transform: 'rotate(0deg)' } },
        reveal: {
          '0%': { opacity: '0', transform: 'translateY(8px)', filter: 'blur(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)', filter: 'blur(0)' },
        },
        shimmer: { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(200%)' } },
        glow: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(34,211,238,0.0), 0 0 18px -6px rgba(34,211,238,0.35)' },
          '50%': { boxShadow: '0 0 0 1px rgba(34,211,238,0.25), 0 0 28px -4px rgba(34,211,238,0.55)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
  darkMode: 'class',
}