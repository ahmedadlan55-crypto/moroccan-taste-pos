// ADLAN — all theme tokens come from frontend/shared/design-tokens.css, bridged
// into Tailwind by frontend/shared/design-tokens.ts (adlanPreset). Edit tokens
// there, never here — hardcoded color literals are forbidden in this file.
import type { Config } from "tailwindcss";
import { adlanPreset } from "../shared/design-tokens";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  presets: [adlanPreset],
  theme: { extend: {} },
} satisfies Config;
