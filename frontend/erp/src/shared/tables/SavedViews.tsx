import { useState } from "react";
import { Bookmark, Check, Plus, Trash2 } from "lucide-react";
import { useLocalStorage } from "@/shared/hooks";
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

export interface SavedViewsProps {
  tableId: string;
  /** The current table state to capture when the user saves a new view. */
  current: SavedViewState;
  onApply: (state: SavedViewState) => void;
}

/** A "Saved views" menu: apply / save / delete per-table view presets. */
export function SavedViews({ tableId, current, onApply }: SavedViewsProps) {
  const { views, save, remove } = useSavedViews(tableId);
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
