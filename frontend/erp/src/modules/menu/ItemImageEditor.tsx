/**
 * Product image manager (close/d-images) — the ERP write-side of the POS
 * thumbnails.
 *
 * The downscale math (≤512px longest side, JPEG q0.8 via canvas, 300KB decoded
 * cap mirroring routes/menu.js) lives in ./imageCompression.ts — shared with
 * the bulk image manager (ImageManager.tsx / ImageManagerBulkUpload.tsx) so
 * there is exactly ONE compression pipeline. Re-exported below for backward
 * compatibility (existing imports/tests reference them from this file).
 *
 * Saving rides the EXISTING menu update path: the host form owns the pending
 * value (`undefined` = untouched, '' = remove on save, string = new image)
 * and sends it as `imageData` through useCreateMenuItem/useUpdateMenuItem.
 * Visibility is gated behind menu.catalog.manage (usePermissions/useCan).
 */
import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useCan } from "@/shared/permissions";
import {
  IMAGE_MAX_SIDE,
  IMAGE_MAX_DECODED_BYTES,
  fitWithin,
  dataUrlDecodedBytes,
  downscaleImageFile,
  imagePrepMessage,
} from "./imageCompression";

export { IMAGE_MAX_SIDE, IMAGE_MAX_DECODED_BYTES, fitWithin, dataUrlDecodedBytes, downscaleImageFile };

export interface ItemImageEditorProps {
  /** The stored image (base64 data URL) from the loaded item; null = none. */
  current: string | null;
  /** Pending edit: undefined = untouched, "" = remove on save, string = new image. */
  pending: string | undefined;
  onChange: (next: string | undefined) => void;
  disabled?: boolean;
}

export function ItemImageEditor({ current, pending, onChange, disabled }: ItemImageEditorProps) {
  const t = useTx();
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
      setError(imagePrepMessage(e, t));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = ""; // re-picking the same file must re-fire onChange
    }
  }

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
      <span className="text-xs font-bold text-slate-600">{t("menuRest.itemImage.label")}</span>
      <div className="mt-2 flex items-center gap-3">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white">
          {preview ? (
            <img src={preview} alt={t("menuRest.itemImage.previewAlt")} data-testid="item-image-preview" className="h-full w-full object-cover" />
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
            aria-label={t("menuRest.itemImage.pickAria")}
            disabled={disabled || busy}
            onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
          />
          <Button type="button" variant="secondary" size="sm" loading={busy} disabled={disabled} onClick={() => inputRef.current?.click()}>
            <ImagePlus className="h-4 w-4" aria-hidden /> {preview ? t("menuRest.itemImage.change") : t("menuRest.itemImage.add")}
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
              <Trash2 className="h-4 w-4" aria-hidden /> {t("menuRest.itemImage.remove")}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-[11px] font-medium text-slate-400">
        {t("menuRest.itemImage.hint", { size: IMAGE_MAX_SIDE })}
      </p>
      {error ? <p className="mt-1 text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}
