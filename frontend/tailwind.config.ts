import type { Config } from "tailwindcss";

/**
 * One dark theme, expressed as CSS variables (globals.css) so surfaces, hairlines and text tones
 * are tuned in one place. Every colour below reads its channel triplet from a variable, which
 * keeps Tailwind's `/opacity` modifiers working (`bg-surface-2/60`).
 */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Page and surface ladder, darkest to lightest.
        canvas: v("canvas"),
        surface: {
          1: v("surface-1"),
          2: v("surface-2"),
          3: v("surface-3"),
        },
        // Hairlines.
        line: {
          DEFAULT: v("line"),
          strong: v("line-strong"),
        },
        // Text tones: primary, secondary, muted.
        ink: {
          1: v("ink-1"),
          2: v("ink-2"),
          3: v("ink-3"),
        },
        // The spine's four hues (globals.css): waiting, now, ran, achieved.
        spine: {
          blue: v("spine-blue"),
          sky: v("spine-sky"),
          green: v("spine-green"),
          volt: v("spine-volt"),
        },
        // The one interactive accent.
        accent: {
          DEFAULT: v("accent"),
          strong: v("accent-strong"),
        },
      },
      fontFamily: {
        // `next/font` loads both and names them through these variables (`app/layout.tsx`); the
        // family names after them only matter if the variables are missing.
        sans: [
          "var(--font-inter)",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "sans-serif",
        ],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        // A soft lift for floating surfaces (menus, dialogs); cards themselves stay flat.
        float: "0 12px 40px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgb(var(--line) / 0.1)",
        ring: "0 0 0 1px rgb(var(--line-strong) / 0.12)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        rise: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 2.5s linear infinite",
        rise: "rise 160ms ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
