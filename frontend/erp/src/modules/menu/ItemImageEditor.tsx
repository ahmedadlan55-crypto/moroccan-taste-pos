/**
 * Product image manager (close/d-images) — the ERP write-side of the POS
 * thumbnails.
 *
 * Storage stays a base64 data-URL in menu.image_data (legacy-compatible, no
 * new infra), but the payload is disciplined at BOTH ends: this editor
 * downscales client-side to ≤512px (longest side) JPEG q0.8 via canvas —
 * which also strips EXIF/metadata, since toDataURL re-encodes pixels only —
 * and routes/menu.js refuses anything that is not a JPEG/PNG/WebP data-URL
 * under 300KB decoded. The POS catalog itself never carries the blob: cards
 * fetch bytes from GET /api/pos/v2/item-image/:id keyed by imageVersion.
 *
 * Saving rides the EXISTING menu update path: the host form owns the pending
 * value (`undefined` = untouched, '' = remove on save, string = new image)
 * and sends it as `imageData` through useCreateMenuItem/useUpdateMenuItem.
 * Visibility is gated behind menu.catalog.manage (usePermissions/useCan).
 */
import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui";
import { useCan } from "@/shared/permissions";

export const IMAGE_MAX_SIDE = 512;
export const IMAGE_JPEG_QUALITY = 0.8;
/** Mirrors routes/menu.js imageDataError — the server refuses > 300KB decoded. */
export const IMAGE_MAX_DECODED_BYTES = 300 * 1024;

/** Pure downscale math: fit (w,h) inside maxSide on the LONGEST side, keeping
 *  aspect ratio, never upscaling, never returning a zero dimension. */
export function fitWithin(width: number, height: number, maxSide: number = IMAGE_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Decoded byte-size of a base64 data URL — size math, no atob round-trip.
 *  Mirrors the server's check so oversize fails HERE with a clear message. */
export function dataUrlDecodedBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length * 3) / 4 - padding;
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("تعذّر قراءة الملف"));
    r.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("الملف ليس صورة صالحة"));
    img.src = src;
  });
}

/** File → ≤512px JPEG q0.8 base64 data URL. The canvas re-encode strips
 *  metadata; a white matte replaces PNG transparency (JPEG has no alpha). */
export async function downscaleImageFile(file: File): Promise<string> {
  const img = await loadImageElement(await readAsDataURL(file));
  const { width, height } = fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("المتصفح لا يدعم معالجة الصور (canvas)");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const out = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
  if (dataUrlDecodedBytes(out) > IMAGE_MAX_DECODED_BYTES) {
    throw new Error("الصورة كبيرة جدًا حتى بعد الضغط — اختر صورة أبسط");
  }
  return out;
}

export interface ItemImageEditorProps {
  /** The stored image (base64 data URL) from the loaded item; null = none. */
  current: string | null;
  /** Pending edit: undefined = untouched, "" = remove on save, string = new image. */
  pending: string | undefined;
  onChange: (next: string | undefined) => void;
  disabled?: boolean;
}

export function ItemImageEditor({ current, pending, onChange, disabled }: ItemImageEditorProps) {
  const canManage = useCan("menu.catalog.manage");
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canManage) return null;

  const preview = pending === undefined ? current : pending === "" ? null : pending;

  async function onPick(file: File | null) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onChange(await downscaleImageFile(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر تجهيز الصورة");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = ""; // re-picking the same file must re-fire onChange
    }
  }

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
      <span className="text-xs font-bold text-slate-600">صورة الصنف</span>
      <div className="mt-2 flex items-center gap-3">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white">
          {preview ? (
            <img src={preview} alt="صورة الصنف" data-testid="item-image-preview" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-6 w-6 text-slate-300" aria-hidden />
          )}
        </div>
        <div className="flex flex-col items-start gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="اختيار صورة الصنف"
            disabled={disabled || busy}
            onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
          />
          <Button type="button" variant="secondary" size="sm" loading={busy} disabled={disabled} onClick={() => inputRef.current?.click()}>
            <ImagePlus className="h-4 w-4" aria-hidden /> {preview ? "تغيير الصورة" : "إضافة صورة"}
          </Button>
          {preview ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
              disabled={disabled || busy}
              onClick={() => {
                setError(null);
                // A stored image needs an explicit '' (clear on save); a purely
                // pending pick just reverts to untouched.
                onChange(current ? "" : undefined);
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden /> إزالة الصورة
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-[11px] font-medium text-slate-400">
        تُصغَّر تلقائيًا إلى {IMAGE_MAX_SIDE} بكسل (JPEG) قبل الحفظ، وتظهر في شاشة الكاشير بعد الحفظ.
      </p>
      {error ? <p className="mt-1 text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}
