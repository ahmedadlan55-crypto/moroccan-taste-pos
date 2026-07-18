/**
 * Preset discounts (خصومات جاهزة) — close/w25-sell-ui.
 *
 * Legacy loaded GET /api/settings/discounts-v2-full once per boot
 * (public/pos/app.js:4996 → state.discountsV3) and offered the rows as one-tap
 * cards inside the line/invoice discount modals (app.js:5343-5500). This module
 * mirrors that read through a PLAIN fetch with the POS Bearer token — lib/api.ts
 * belongs to a parallel stream and is not touched. Rows are cached for the
 * session; any failure degrades to [] so manual discount entry keeps working
 * exactly as today (an old server without the endpoint behaves the same).
 */
import { useEffect, useState } from "react";
import { getToken } from "./auth";
import { round2 } from "./cartMath";
import type { DiscountType } from "./types";

/** A raw row from /api/settings/discounts-v2-full (legacy discountsV3 shape). */
interface DiscountPresetRow {
  id: number | string;
  name?: string;
  type?: string; // 'percentage' | 'fixed'
  value?: number | string;
  enabled?: boolean;
  showInPos?: boolean;
  discountScope?: string; // 'line' | 'invoice' | 'preset' | 'manual'
  minOrder?: number | string | null;
  maxAmount?: number | string | null;
}

export interface DiscountPreset {
  id: number | string;
  name: string;
  /** Mapped to the React form's type: 'percentage' → PERCENT, else FIXED. */
  type: DiscountType;
  value: number;
  scope: string;
  minOrder: number | null;
  maxAmount: number | null;
}

const ENDPOINT = "/api/settings/discounts-v2-full";

let cache: Promise<DiscountPreset[]> | null = null;

async function fetchRows(): Promise<DiscountPreset[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(ENDPOINT, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()) as DiscountPresetRow[];
  if (!Array.isArray(rows)) return [];
  // Same visibility filter legacy applied at both modals (app.js:5346, 5440).
  return rows
    .filter((d) => d && d.enabled && d.showInPos !== false && (Number(d.value) || 0) > 0 && String(d.name ?? "").trim())
    .map((d) => ({
      id: d.id,
      name: String(d.name).trim(),
      type: (String(d.type).toLowerCase() === "percentage" ? "PERCENT" : "FIXED") as DiscountType,
      value: Number(d.value) || 0,
      scope: String(d.discountScope ?? ""),
      minOrder: d.minOrder != null && Number(d.minOrder) > 0 ? Number(d.minOrder) : null,
      maxAmount: d.maxAmount != null && Number(d.maxAmount) > 0 ? Number(d.maxAmount) : null,
    }));
}

/** Session-cached load; a failure resolves [] and clears the cache for retry. */
export function loadDiscountPresets(): Promise<DiscountPreset[]> {
  if (!cache) {
    cache = fetchRows().catch(() => {
      cache = null; // retry on the next open — outages should not stick
      return [];
    });
  }
  return cache;
}

/** Test hook — resets the session cache. */
export function _resetDiscountPresetsCache(): void {
  cache = null;
}

/** Legacy scope filter (app.js:5346/5440): the target scope + the shared
 *  'preset'/'manual' scopes appear in BOTH modals. */
export function presetsForScope(all: DiscountPreset[], scope: "line" | "invoice"): DiscountPreset[] {
  return all.filter((p) => p.scope === scope || p.scope === "preset" || p.scope === "manual");
}

/** The ر.س amount a preset yields on a line gross (legacy posApplyLineDiscount
 *  app.js:5405-5420: percentage of the gross, capped by maxAmount then the
 *  line total — the same clamp cartMath applies to manual entry). */
export function presetLineAmount(p: DiscountPreset, lineGross: number): number {
  let amt = p.type === "PERCENT" ? (lineGross * p.value) / 100 : p.value;
  if (p.maxAmount != null && amt > p.maxAmount) amt = p.maxAmount;
  if (amt > lineGross) amt = lineGross;
  return round2(Math.max(0, amt));
}

/** React hook: presets once `enabled` (dialog open / row expanded); [] until
 *  loaded and on any failure. */
export function useDiscountPresets(enabled: boolean): DiscountPreset[] {
  const [presets, setPresets] = useState<DiscountPreset[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadDiscountPresets().then((p) => {
      if (alive) setPresets(p);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return presets;
}
