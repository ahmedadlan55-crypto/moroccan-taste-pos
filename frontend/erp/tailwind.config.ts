// ADLAN — all theme tokens come from frontend/shared/design-tokens.css, bridged
// into Tailwind by frontend/shared/design-tokens.ts (adlanPreset). Edit tokens
// there, never here — hardcoded color literals are forbidden in this file.
import type { Config } from "tailwindcss";
import { adlanPreset } from "../shared/design-tokens";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  presets: [adlanPreset],
  theme: {
    extend: {
      // Cairo ships a variable 400–700 weight axis (no real 800/900). Mapping
      // the existing utility names caps bold/extrabold at real weights and
      // avoids a synthetic 800, keeping a clear hierarchy across the legacy
      // screens without a risky mass rewrite.
      fontWeight: {
        normal: "400",
        medium: "500",
        semibold: "600",
        bold: "600",
        extrabold: "700",
      },
    },
  },
} satisfies Config;
