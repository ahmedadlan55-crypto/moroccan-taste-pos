/**
 * Client-side image compression math (close/d-images) — extracted out of
 * ItemImageEditor.tsx so both the single-item editor AND the bulk image
 * manager (ImageManager.tsx / ImageManagerBulkUpload.tsx) import the SAME
 * downscale pipeline instead of duplicating it.
 *
 * Storage stays a base64 data-URL in menu.image_data (legacy-compatible, no
 * new infra), but the payload is disciplined at BOTH ends: this module
 * downscales client-side to ≤512px (longest side) JPEG q0.8 via canvas —
 * which also strips EXIF/metadata, since toDataURL re-encodes pixels only —
 * and routes/menu.js refuses anything that is not a JPEG/PNG/WebP data-URL
 * under 300KB decoded. The POS catalog itself never carries the blob: cards
 * fetch bytes from GET /api/pos/v2/item-image/:id keyed by imageVersion.
 *
 * PURE MOVE (2026-07-20): this is a verbatim relocation of the functions that
 * used to live at the top of ItemImageEditor.tsx — no behavior change. See
 * ItemImageEditor.tsx, which re-exports these for backward compatibility.
 */

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
  // Matte color comes from the design-token source (--mt-surface), not a
  // hardcoded literal here — see frontend/shared/design-tokens.css.
  const matte = getComputedStyle(document.documentElement).getPropertyValue("--mt-surface").trim();
  ctx.fillStyle = matte || "white";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const out = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
  if (dataUrlDecodedBytes(out) > IMAGE_MAX_DECODED_BYTES) {
    throw new Error("الصورة كبيرة جدًا حتى بعد الضغط — اختر صورة أبسط");
  }
  return out;
}
