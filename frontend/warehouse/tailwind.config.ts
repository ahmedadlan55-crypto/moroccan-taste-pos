import type { Config } from "tailwindcss";

// ADLAN ERP design tokens — a single petrol accent (#0E7490), dark-navy chrome
// (#0E1726), cool-neutral surfaces, and IBM Plex Sans Arabic. These values are
// mapped onto the EXISTING token names (teal / saffron / ink / canvas) so every
// component adopts the new identity with zero code changes — presentation only,
// no logic touched. Extracted from the ADLAN Design System (Claude Design).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans Arabic", "Tajawal", "Segoe UI", "Tahoma", "Arial", "sans-serif"],
      },
      colors: {
        ink: "#101828", // primary text / dark chrome
        canvas: "#f2f5f9", // app background
        // Primary accent — "أدلان بترولي" (petrol). Mapped onto `teal` so every
        // existing bg-teal-*/text-teal-*/ring-teal-* adopts it unchanged.
        teal: {
          50: "#e6f3f7",
          100: "#cfe9f1",
          200: "#a5d8e6",
          500: "#1591b0",
          600: "#0e7490",
          700: "#155e75",
        },
        // Secondary highlight remapped to the ADLAN warning amber.
        saffron: {
          50: "#fffbeb",
          100: "#fef3c7",
          500: "#d97706",
          600: "#b45309",
        },
      },
      borderRadius: {
        xl: "0.625rem", // 10px — buttons/controls
        "2xl": "0.875rem", // 14px — cards/surfaces
      },
      boxShadow: {
        soft: "0 2px 8px rgba(15, 23, 42, 0.06)",
        lift: "0 8px 20px rgba(15, 23, 42, 0.10)",
      },
      minHeight: {
        11: "2.75rem", // 44px touch target
      },
    },
  },
  plugins: [],
} satisfies Config;
