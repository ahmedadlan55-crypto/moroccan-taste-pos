/**
 * ImageManagerBulkUpload — the bulk-upload dialog opened from ImageManager's
 * bulkActions/toolbar. Flow:
 *   1) drop/pick files (FileUploader)
 *   2) auto-match each file to a menu item by filename containing the item's
 *      id/SKU/barcode (case-insensitive substring, against the item list
 *      ImageManager currently has loaded/filtered)
 *   3) files that don't match land in a manual-assign list — pick a target
 *      item per file via SearchableEntityCombobox (same picker Combos.tsx uses)
 *   4) on confirm, every assigned file is compressed through the SAME pipeline
 *      ItemImageEditor uses (./imageCompression.ts — downscaleImageFile) and
 *      submitted via useBulkUploadImages()
 *   5) per-file success/rejected results are shown (client-side compression
 *      failures AND server-reported per-item results, keyed by menuId)
 */
import { useMemo, useState } from "react";
import { CheckCircle2, Trash2, XCircle } from "lucide-react";
import { Dialog, Button, IconButton, FileUploader, SearchableEntityCombobox, useToast } from "@/shared/ui";
import { downscaleImageFile } from "./imageCompression";
import {
  useBulkUploadImages,
  makeMenuItemFetcher,
  type MenuItem,
  type BulkImageUploadItem,
} from "./api";

// Generous pre-compression cap so obviously-wrong files (e.g. a stray PDF
// renamed .jpg, a multi-MB RAW export) are rejected before FileReader even
// touches them; downscaleImageFile enforces the REAL ≤300KB post-compression
// limit that routes/menu.js mirrors.
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Identifying strings to try when matching a filename to an item. `sku` /
 *  `barcode` aren't on the current MenuItem type (menu items don't carry
 *  them today) — read defensively via an unknown-keyed cast so this starts
 *  matching automatically the day either field is added upstream. */
function candidateKeys(item: MenuItem): string[] {
  const raw = item as unknown as Record<string, unknown>;
  return [item.id, raw.sku, raw.barcode, raw.code]
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 3)
    .map((v) => v.trim().toLowerCase());
}

/** Longest-key-wins substring match against the file's base name (extension
 *  stripped) — avoids a short id false-matching inside an unrelated longer
 *  filename. */
function matchItemForFile(fileName: string, items: MenuItem[]): MenuItem | null {
  const base = fileName.replace(/\.[^/.]+$/, "").toLowerCase();
  let best: { item: MenuItem; key: string } | null = null;
  for (const item of items) {
    for (const key of candidateKeys(item)) {
      if (base.includes(key) && (!best || key.length > best.key.length)) {
        best = { item, key };
      }
    }
  }
  return best?.item ?? null;
}

interface PickedFile {
  fileKey: string;
  file: File;
  /** null = unmatched, needs manual assignment. */
  matchedItem: MenuItem | null;
}

let _seq = 0;
const nextKey = () => `img-bulk-${Date.now()}-${_seq++}`;

interface FileResult {
  fileKey: string;
  ok: boolean;
  code?: string;
  error?: string;
}

export interface ImageManagerBulkUploadProps {
  open: boolean;
  onClose: () => void;
  /** The item pool files are matched/assigned against — ImageManager passes
   *  its currently-loaded (filtered) list. */
  items: MenuItem[];
}

export function ImageManagerBulkUpload({ open, onClose, items }: ImageManagerBulkUploadProps) {
  const { toast } = useToast();
  const bulk = useBulkUploadImages();
  const fetcher = useMemo(() => makeMenuItemFetcher(items), [items]);

  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [prepFailures, setPrepFailures] = useState<{ fileKey: string; reason: string }[]>([]);
  const [results, setResults] = useState<FileResult[] | null>(null);

  function handleFiles(files: File[]) {
    const additions = files.map((file) => ({
      fileKey: nextKey(),
      file,
      matchedItem: matchItemForFile(file.name, items),
    }));
    setPicked((p) => [...p, ...additions]);
  }

  function assign(fileKey: string, item: MenuItem | null) {
    setPicked((p) => p.map((f) => (f.fileKey === fileKey ? { ...f, matchedItem: item } : f)));
  }

  function removeFile(fileKey: string) {
    setPicked((p) => p.filter((f) => f.fileKey !== fileKey));
  }

  const matched = picked.filter((f) => f.matchedItem);
  const unmatched = picked.filter((f) => !f.matchedItem);
  const readyCount = matched.length;

  async function submit() {
    if (readyCount === 0 || submitting) return;
    setSubmitting(true);
    setPrepFailures([]);

    const compressed: { fileKey: string; upload: BulkImageUploadItem }[] = [];
    const failures: { fileKey: string; reason: string }[] = [];
    for (const f of matched) {
      try {
        const imageData = await downscaleImageFile(f.file);
        compressed.push({ fileKey: f.fileKey, upload: { menuId: f.matchedItem!.id, imageData } });
      } catch (e) {
        failures.push({ fileKey: f.fileKey, reason: e instanceof Error ? e.message : "تعذّر تجهيز الصورة" });
      }
    }
    setPrepFailures(failures);

    if (compressed.length === 0) {
      setSubmitting(false);
      return;
    }

    bulk.mutate(
      compressed.map((c) => c.upload),
      {
        onSuccess: (res) => {
          const byMenuId = new Map(res.results.map((r) => [r.menuId, r]));
          const mapped: FileResult[] = compressed.map(({ fileKey, upload }) => {
            const r = byMenuId.get(upload.menuId);
            return { fileKey, ok: r?.ok ?? false, code: r?.code, error: r?.error };
          });
          setResults(mapped);
          setSubmitting(false);
          const okCount = mapped.filter((m) => m.ok).length;
          toast({
            title: `تم رفع ${okCount} من ${mapped.length} صورة`,
            tone: okCount === mapped.length ? "success" : "warning",
          });
        },
        onError: (e: Error) => {
          setSubmitting(false);
          toast({ title: "تعذّر رفع الصور", description: e.message, tone: "error" });
        },
      },
    );
  }

  function handleClose() {
    if (submitting) return;
    setPicked([]);
    setPrepFailures([]);
    setResults(null);
    onClose();
  }

  const step: "pick" | "result" = results ? "result" : "pick";
  const byKey = new Map(picked.map((f) => [f.fileKey, f]));

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="رفع صور جماعي"
      description="اسحب صور الأصناف — سيتم مطابقتها تلقائيًا برقم الصنف الظاهر في اسم الملف، وما لا يُطابَق يُخصَّص يدويًا أدناه."
      size="lg"
      dismissable={!submitting}
      footer={
        step === "pick" ? (
          <>
            <Button variant="secondary" onClick={handleClose} disabled={submitting}>إلغاء</Button>
            <Button onClick={() => void submit()} loading={submitting} disabled={readyCount === 0}>
              {readyCount > 0 ? `رفع ${readyCount} صورة` : "رفع"}
            </Button>
          </>
        ) : (
          <Button onClick={handleClose}>تم</Button>
        )
      }
    >
      {step === "pick" ? (
        <div className="space-y-5">
          <FileUploader
            onFiles={handleFiles}
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={submitting}
            maxSize={MAX_FILE_BYTES}
            onReject={(reason, file) => toast({ title: `تعذّر قبول ${file.name}`, description: reason, tone: "error" })}
            hint="اسحب صور الأصناف هنا أو اضغط للاختيار (JPEG, PNG, WebP)"
          />

          {picked.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs font-medium text-slate-400">
              لم تُختَر أي ملفات بعد.
            </p>
          ) : (
            <div className="space-y-4">
              {matched.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-extrabold text-slate-800">مطابقة تلقائيًا ({matched.length})</h3>
                  <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                    {matched.map((f) => (
                      <FileRow key={f.fileKey} f={f} fetcher={fetcher} onAssign={assign} onRemove={removeFile} disabled={submitting} />
                    ))}
                  </ul>
                </div>
              )}
              {unmatched.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-extrabold text-slate-800">بحاجة إلى تخصيص يدوي ({unmatched.length})</h3>
                  <ul className="divide-y divide-amber-100 rounded-xl border border-amber-200 bg-amber-50/40">
                    {unmatched.map((f) => (
                      <FileRow key={f.fileKey} f={f} fetcher={fetcher} onAssign={assign} onRemove={removeFile} disabled={submitting} />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {prepFailures.length > 0 && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
              <h3 className="mb-1 text-xs font-extrabold text-rose-700">تعذّر تجهيز {prepFailures.length} ملف</h3>
              <ul className="space-y-0.5 text-xs font-medium text-rose-600">
                {prepFailures.map((f) => (
                  <li key={f.fileKey}>{byKey.get(f.fileKey)?.file.name ?? "—"} — {f.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {(results ?? []).map((r) => {
              const f = byKey.get(r.fileKey);
              return (
                <li key={r.fileKey} className="flex items-center gap-3 p-3">
                  {r.ok ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
                  ) : (
                    <XCircle className="h-5 w-5 shrink-0 text-rose-600" aria-hidden />
                  )}
                  <span dir="ltr" className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">
                    {f?.file.name ?? "—"}
                  </span>
                  <span className="min-w-0 shrink-0 truncate text-xs font-medium text-slate-400">
                    {f?.matchedItem?.name}
                  </span>
                  {!r.ok && (r.error || r.code) && (
                    <span className="max-w-[40%] shrink-0 truncate text-xs font-bold text-rose-600" title={r.error || r.code}>
                      {r.error || r.code}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {prepFailures.length > 0 && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
              <h3 className="mb-1 text-xs font-extrabold text-rose-700">لم تُرفَع {prepFailures.length} ملف (فشل التجهيز قبل الإرسال)</h3>
              <ul className="space-y-0.5 text-xs font-medium text-rose-600">
                {prepFailures.map((f) => (
                  <li key={f.fileKey}>{byKey.get(f.fileKey)?.file.name ?? "—"} — {f.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function FileRow({
  f,
  fetcher,
  onAssign,
  onRemove,
  disabled,
}: {
  f: PickedFile;
  fetcher: ReturnType<typeof makeMenuItemFetcher>;
  onAssign: (fileKey: string, item: MenuItem | null) => void;
  onRemove: (fileKey: string) => void;
  disabled?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 p-3">
      <span dir="ltr" className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">
        {f.file.name}
      </span>
      <div className="w-56 shrink-0">
        <SearchableEntityCombobox<MenuItem>
          value={f.matchedItem}
          onChange={(v) => onAssign(f.fileKey, v)}
          fetcher={fetcher}
          queryKey={["menu", "image-bulk-assign"]}
          getKey={(m) => m.id}
          getLabel={(m) => m.name}
          getSublabel={(m) => m.category || undefined}
          placeholder="اختر صنفًا…"
          ariaLabel={`تخصيص صنف لـ ${f.file.name}`}
          emptyText="لا أصناف مطابقة."
          disabled={disabled}
        />
      </div>
      <IconButton size="sm" aria-label={`إزالة ${f.file.name}`} disabled={disabled} onClick={() => onRemove(f.fileKey)}>
        <Trash2 className="h-4 w-4 text-rose-500" />
      </IconButton>
    </li>
  );
}
