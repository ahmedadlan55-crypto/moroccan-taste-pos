import type { Config } from "tailwindcss";

// Design tokens lifted from the approved prototype
// (artifacts/warehouse-react-prototype) and promoted to real Tailwind tokens
// instead of inline hex — Teal primary, Saffron secondary, dark sidebar ink.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Tajawal", "Segoe UI", "Tahoma", "Arial", "sans-serif"],
      },
      colors: {
        ink: "#172033",
        canvas: "#f5f7fb",
        teal: {
          50: "#effcf9",
          100: "#d7f7ef",
          200: "#aeeede",
          500: "#18a383",
          600: "#0c8b6f",
          700: "#0b6f5b",
        },
        saffron: {
          50: "#fff9ed",
          100: "#fff0ce",
          500: "#e7a527",
          600: "#c78113",
        },
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        soft: "0 18px 45px -28px rgba(15, 23, 42, .35)",
        lift: "0 20px 60px -30px rgba(15, 23, 42, .45)",
      },
      minHeight: {
        11: "2.75rem", // 44px touch target
      },
    },
  },
  plugins: [],
} satisfies Config;
