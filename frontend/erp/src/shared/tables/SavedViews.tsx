import { useEffect, useState } from "react";
import { Bookmark, Check, Plus, Trash2 } from "lucide-react";
import { useLocalStorage } from "@/shared/hooks";
import { apiClient } from "@/shared/api";
import { Button, DropdownMenu, Dialog, Input } from "@/shared/ui";
import type { TableSort } from "./types";

export interface SavedViewState {
  hiddenColumns?: string[];
  sort?: TableSort | null;
  pageSize?: number;
  filters?: Record<string, unknown>;
}

export interface SavedView {
  id: string;
  name: string;
  state: SavedViewState;
}

/** Read/write named table views persisted to localStorage, scoped per table id. */
export function useSavedViews(tableId: string) {
  const [views, setViews] = useLocalStorage<SavedView[]>(`adlan.views.${tableId}`, []);

  const save = (name: string, state: SavedViewState) => {
    const view: SavedView = { id: `${Date.now()}`, name: name.trim(), state };
    setViews((list) => [...list.filter((v) => v.name !== view.name), view]);
    return view;
  };
  const remove = (id: string) => setViews((list) => list.filter((v) => v.id !== id));

  return { views, save, remove };
}

// ── Server-backed saved views (A2 `/api/saved-views`) with a localStorage
//    fallback. The three JSON columns the endpoint exposes hold the whole
//    {hiddenColumns, sort, pageSize, filters} capture: columnsJson=hiddenColumns,
//    sortJson=sort, filtersJson={filters, pageSize}. If the endpoint is missing
//    (404 while A2 ships it) or unreachable, we transparently stay on
//    localStorage so this control NEVER hard-breaks a screen. ──

interface ServerSavedView {
  id: string | number;
  name: string;
  isDefault?: boolean;
  isShared?: boolean;
  filtersJson?: string | null;
  columnsJson?: string | null;
  sortJson?: string | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fromServer(v: ServerSavedView): SavedView {
  const filterBlob = parseJson<{ filters?: Record<string, unknown>; pageSize?: number }>(v.filtersJson, {});
  return {
    id: String(v.id),
    name: v.name,
    state: {
      hiddenColumns: parseJson<string[]>(v.columnsJson, []),
      sort: parseJson<TableSort | null>(v.sortJson, null),
      pageSize: filterBlob.pageSize,
      filters: filterBlob.filters ?? {},
    },
  };
}

function toServerPayload(name: string, state: SavedViewState) {
  return {
    name: name.trim(),
    columnsJson: JSON.stringify(state.hiddenColumns ?? []),
    sortJson: JSON.stringify(state.sort ?? null),
    filtersJson: JSON.stringify({ filters: state.filters ?? {}, pageSize: state.pageSize }),
  };
}

/**
 * View source that prefers the `/api/saved-views?module=` endpoint and falls
 * back to localStorage when a `module` is not given or the endpoint is not
 * reachable. Writes are optimistic and mirrored to localStorage on server
 * failure, so the control keeps working entirely offline.
 */
export function useSavedViewsSource(tableId: string, module?: string) {
  const localKey = module ?? tableId;
  const [local, setLocal] = useLocalStorage<SavedView[]>(`adlan.views.${localKey}`, []);
  // null → server not (yet) available; use localStorage. Array → server is live.
  const [server, setServer] = useState<SavedView[] | null>(null);

  useEffect(() => {
    if (!module) {
      setServer(null);
      return;
    }
    let alive = true;
    apiClient
      .get<ServerSavedView[]>("/saved-views", { params: { module } })
      .then((rows) => {
        if (alive) setServer(Array.isArray(rows) ? rows.map(fromServer) : []);
      })
      .catch(() => {
        // 404 (A2 not shipped) / network / forbidden → stay on localStorage.
        if (alive) setServer(null);
      });
    return () => {
      alive = false;
    };
  }, [module]);

  const usingServer = !!module && server !== null;
  const views = usingServer ? (server as SavedView[]) : local;

  const save = (name: string, state: SavedViewState) => {
    const optimistic: SavedView = { id: `tmp-${Date.now()}`, name: name.trim(), state };
    if (usingServer && module) {
      setServer((prev) => [...(prev ?? []).filter((v) => v.name !== optimistic.name), optimistic]);
      apiClient
        .post<ServerSavedView>("/saved-views", { module, ...toServerPayload(name, state) })
        .then((created) =>
          setServer((prev) => (prev ?? []).map((v) => (v.id === optimistic.id ? fromServer(created) : v))),
        )
        .catch(() => {
          // Persist to localStorage so the view survives the failed round-trip.
          setLocal((list) => [...list.filter((v) => v.name !== optimistic.name), optimistic]);
        });
    } else {
      setLocal((list) => [...list.filter((v) => v.name !== optimistic.name), optimistic]);
    }
  };

  const remove = (id: string) => {
    if (usingServer && module) {
      setServer((prev) => (prev ?? []).filter((v) => v.id !== id));
      apiClient.delete(`/saved-views/${id}`).catch(() => {
        /* best-effort — the optimistic removal already dropped it from the list */
      });
    } else {
      setLocal((list) => list.filter((v) => v.id !== id));
    }
  };

  return { views, save, remove };
}

export interface SavedViewsProps {
  tableId: string;
  /** The current table state to capture when the user saves a new view. */
  current: SavedViewState;
  onApply: (state: SavedViewState) => void;
  /**
   * When set, views sync with `/api/saved-views?module=<module>` (A2) with a
   * localStorage fallback. Omit to keep the localStorage-only behavior.
   */
  module?: string;
}

/** A "Saved views" menu: apply / save / delete per-table view presets. */
export function SavedViews({ tableId, current, onApply, module }: SavedViewsProps) {
  const { views, save, remove } = useSavedViewsSource(tableId, module);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");

  return (
    <>
      <DropdownMenu
        aria-label="طرق العرض المحفوظة"
        trigger={
          <span className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600 hover:bg-slate-50">
            <Bookmark className="h-4 w-4" /> طرق العرض
          </span>
        }
        items={[
          ...views.map((v) => ({
            key: v.id,
            label: v.name,
            icon: <Check className="h-4 w-4" />,
            onSelect: () => onApply(v.state),
          })),
          ...views.map((v) => ({
            key: `del-${v.id}`,
            label: `حذف: ${v.name}`,
            icon: <Trash2 className="h-4 w-4" />,
            tone: "danger" as const,
            onSelect: () => remove(v.id),
          })),
          {
            key: "__save__",
            label: "حفظ العرض الحالي…",
            icon: <Plus className="h-4 w-4" />,
            onSelect: () => {
              setName("");
              setDialogOpen(true);
            },
          },
        ]}
      />
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="حفظ طريقة العرض"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              إلغاء
            </Button>
            <Button
              disabled={name.trim().length === 0}
              onClick={() => {
                save(name, current);
                setDialogOpen(false);
              }}
            >
              حفظ
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="text-xs font-bold text-slate-600">اسم العرض</span>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثال: الفواتير المتأخرة"
            autoFocus
          />
        </label>
      </Dialog>
    </>
  );
}
