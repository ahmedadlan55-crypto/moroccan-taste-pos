import { useId, useRef, useState, type DragEvent } from "react";
import { FileUp, Paperclip, X } from "lucide-react";
import { cn } from "@/shared/lib";
import { useTx } from "./i18n";

export interface FileUploaderProps {
  /** Fires with the accepted File list whenever the selection changes. */
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Max size per file in bytes; oversize files are rejected via onReject. */
  maxSize?: number;
  onReject?: (reason: string, file: File) => void;
  hint?: string;
}

/**
 * Accessible drag-and-drop file picker. A real <input type=file> keeps keyboard
 * and screen-reader behavior; the drop zone is a labelled button. Does NOT
 * upload — it hands Files to the caller (upload is a domain concern).
 */
export function FileUploader({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  maxSize,
  onReject,
  hint,
}: FileUploaderProps) {
  const t = useTx();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const id = useId();

  function accepted(list: FileList | null): File[] {
    const files = Array.from(list ?? []);
    if (maxSize == null) return files;
    return files.filter((f) => {
      if (f.size > maxSize) {
        onReject?.(t("sharedUi.fileUploader.tooLarge"), f);
        return false;
      }
      return true;
    });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    onFiles(accepted(e.dataTransfer.files));
  }

  return (
    <div>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => onFiles(accepted(e.target.files))}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 disabled:cursor-not-allowed disabled:opacity-60",
          dragging ? "border-teal-400 bg-teal-50" : "border-slate-200 bg-slate-50 hover:border-slate-300",
        )}
      >
        <FileUp className={cn("h-6 w-6", dragging ? "text-teal-600" : "text-slate-400")} aria-hidden="true" />
        <span className="text-sm font-bold text-slate-600">{hint ?? t("sharedUi.fileUploader.hint")}</span>
      </button>
    </div>
  );
}

export interface Attachment {
  id: string | number;
  name: string;
  url?: string;
  size?: number;
  contentType?: string;
}

function humanSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentViewerProps {
  attachments: Attachment[];
  /** When provided, each row shows a remove button. */
  onRemove?: (id: Attachment["id"]) => void;
  emptyText?: string;
}

/** Read-only list of uploaded attachments with a link + optional remove. */
export function AttachmentViewer({
  attachments,
  onRemove,
  emptyText,
}: AttachmentViewerProps) {
  const t = useTx();
  if (attachments.length === 0) {
    return <p className="text-sm font-medium text-slate-400">{emptyText ?? t("sharedUi.fileUploader.empty")}</p>;
  }
  return (
    <ul className="space-y-2">
      {attachments.map((a) => (
        <li
          key={a.id}
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2"
        >
          <Paperclip className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {a.url ? (
              <a
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-sm font-bold text-teal-700 hover:underline"
              >
                {a.name}
              </a>
            ) : (
              <span className="truncate text-sm font-bold text-slate-800">{a.name}</span>
            )}
            {a.size != null && (
              <span dir="ltr" className="block text-[11px] font-medium tabular-nums text-slate-400">
                {humanSize(a.size)}
              </span>
            )}
          </div>
          {onRemove && (
            <button
              type="button"
              aria-label={t("sharedUi.fileUploader.remove", { name: a.name })}
              onClick={() => onRemove(a.id)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
