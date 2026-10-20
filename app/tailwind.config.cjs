// Tailwind v3 for the room page (design.md D1). Preflight is off so the page's own
// CSS, moved verbatim into styles/room.css, keeps the geometry the drivers click by.
// Every value is a var(--…) reference: the tokens live once, in room.css (design.md D3).
module.exports = {
  content: ['./public/room.html', './public/room/**/*.jsx'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        page: 'var(--page)',
        panel: 'var(--panel)',
        popover: { DEFAULT: 'var(--popover)', hover: 'var(--popover-hover)' },
        ink: 'var(--ink)',
        secondary: 'var(--secondary)',
        placeholder: 'var(--placeholder)',
        disabled: 'var(--disabled-ink)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          pressed: 'var(--accent-pressed)',
          ink: 'var(--on-accent)',
        },
        warning: 'var(--warning)',
        'sync-ok': 'var(--sync-ok)',
        'sync-correcting': 'var(--sync-correcting)',
        hairline: { DEFAULT: 'var(--hairline)', strong: 'var(--hairline-strong)' },
        wash: { DEFAULT: 'var(--wash)', strong: 'var(--wash-strong)' },
      },
      borderRadius: { DEFAULT: 'var(--radius)', control: 'var(--radius-control)', inner: 'var(--radius-inner)' },
      fontFamily: { sans: 'var(--font-sans)', mono: 'var(--font-mono)' },
    },
  },
};
