import { useEffect, useState } from "react";
import { Bookmark, Check, Plus, Trash2 } from "lucide-react";
import { useLocalStorage } from "@/shared/hooks";
import { apiClient } from "@/shared/api";
import { Button, DropdownMenu, Dialog, Input } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
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
//    localStorage so this control NEVER hard-breaks a screen.
//
//    CONTRACT (routes/saved-views.js): every response is a { success, data }
//    ENVELOPE, and the three *Json fields are opaque JSON VALUES — the server
//    JSON.stringify's on write and JSON.parse's on read. So the client sends
//    plain values and reads plain values back. (The first cut of this hook
//    missed both: it treated the envelope as the row array — so "server mode"
//    was permanently empty — and double-stringified the payloads, which the
//    server then wrapped again. Legacy double-encoded rows written by that cut
//    still round-trip: a string value is JSON.parse'd once, tolerantly.) ──

interface ServerSavedView {
  id: string | number;
  name: string;
  isDefault?: boolean;
  isShared?: boolean;
  filtersJson?: unknown;
  columnsJson?: unknown;
  sortJson?: unknown;
}

/** Unwrap the { success, data } envelope; tolerate a bare array/row (mocks). */
function unwrapList(v: unknown): ServerSavedView[] | null {
  if (Array.isArray(v)) return v as ServerSavedView[];
  if (v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)) {
    return (v as { data: ServerSavedView[] }).data;
  }
  return null;
}

function unwrapRow(v: unknown): ServerSavedView | null {
  if (!v || typeof v !== "object") return null;
  const data = (v as { data?: unknown }).data;
  if (data && typeof data === "object") return data as ServerSavedView;
  return "id" in (v as Record<string, unknown>) ? (v as ServerSavedView) : null;
}

/** The server already parsed the JSON columns — take the VALUE. A string is a
 *  legacy double-encoded blob from the first cut: parse it once, tolerantly. */
function asValue<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function fromServer(v: ServerSavedView): SavedView {
  const filterBlob = asValue<{ filters?: Record<string, unknown>; pageSize?: number }>(v.filtersJson, {});
  return {
    id: String(v.id),
    name: v.name,
    state: {
      hiddenColumns: asValue<string[]>(v.columnsJson, []),
      sort: asValue<TableSort | null>(v.sortJson, null),
      pageSize: filterBlob.pageSize,
      filters: filterBlob.filters ?? {},
    },
  };
}

function toServerPayload(name: string, state: SavedViewState) {
  // Plain JSON VALUES — the server serializes them itself (opaque-value contract).
  return {
    name: name.trim(),
    columnsJson: state.hiddenColumns ?? [],
    sortJson: state.sort ?? null,
    filtersJson: { filters: state.filters ?? {}, pageSize: state.pageSize },
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
      .get<unknown>("/saved-views", { params: { module } })
      .then((res) => {
        if (!alive) return;
        const rows = unwrapList(res);
        // An unrecognized body means the endpoint is not really there (e.g. an
        // HTML fallback) → stay on localStorage rather than showing "empty".
        setServer(rows ? rows.map(fromServer) : null);
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
        .post<unknown>("/saved-views", { module, ...toServerPayload(name, state) })
        .then((res) => {
          const created = unwrapRow(res);
          if (!created) return; // keep the optimistic row — nothing usable came back
          setServer((prev) => (prev ?? []).map((v) => (v.id === optimistic.id ? fromServer(created) : v)));
        })
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
  const t = useTx();
  const { views, save, remove } = useSavedViewsSource(tableId, module);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");

  return (
    <>
      <DropdownMenu
        aria-label={t("table.savedViews.ariaMenu")}
        trigger={
          <span className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600 hover:bg-slate-50">
            <Bookmark className="h-4 w-4" /> {t("table.savedViews.menu")}
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
            label: t("table.savedViews.delete", { name: v.name }),
            icon: <Trash2 className="h-4 w-4" />,
            tone: "danger" as const,
            onSelect: () => remove(v.id),
          })),
          {
            key: "__save__",
            label: t("table.savedViews.saveCurrent"),
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
        title={t("table.savedViews.saveTitle")}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={name.trim().length === 0}
              onClick={() => {
                save(name, current);
                setDialogOpen(false);
              }}
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="text-xs font-bold text-slate-600">{t("table.savedViews.nameLabel")}</span>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("table.savedViews.namePlaceholder")}
            autoFocus
          />
        </label>
      </Dialog>
    </>
  );
}
