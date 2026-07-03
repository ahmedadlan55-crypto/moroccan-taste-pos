import { useEffect, useMemo, useState } from "react";
import { Search, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/states/States";
import {
  useWarehouseScopeAssignments,
  useSaveScopeAssignments,
} from "@/lib/hooks/useWarehouseAdmin";

// صلاحيات الوصول — admin-only editor for user_warehouse_access (Phase W6).
// Checkbox list of active users; Save REPLACES the warehouse's rows via PUT.
// Admins/developers have implicit global access and are shown as such.

const ROLE_LABEL: Record<string, string> = {
  admin: "مسؤول",
  manager: "مدير",
  employee: "موظف",
  custody: "عهدة",
  cashier: "كاشير",
  auditor: "مدقق",
};

export function ScopeAssignmentsSection({ warehouseId }: { warehouseId: string }) {
  const { data, isLoading, isError, error, refetch } = useWarehouseScopeAssignments(warehouseId);
  const save = useSaveScopeAssignments();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  // Sync local selection from the server whenever fresh data arrives and the
  // user hasn't started editing.
  useEffect(() => {
    if (!data || dirty) return;
    setSelected(new Set(data.assignments.map((a) => a.userId)));
  }, [data, dirty]);

  const users = useMemo(() => {
    const list = data?.users ?? [];
    const q = query.trim();
    return q ? list.filter((u) => `${u.username} ${u.fullName}`.includes(q)) : list;
  }, [data, query]);

  if (isLoading) {
    return (
      <div className="grid place-items-center p-8">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  function toggle(id: number) {
    setDirty(true);
    setSavedFlash(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    try {
      await save.mutateAsync({ id: warehouseId, userIds: Array.from(selected) });
      setDirty(false);
      setSavedFlash(true);
    } catch {
      // error renders inline below
    }
  }

  const globalUsers = users.filter((u) => u.role.toLowerCase() === "admin");
  const scopedUsers = users.filter((u) => u.role.toLowerCase() !== "admin");

  return (
    <div>
      <div className="flex items-start gap-2 rounded-xl border border-sky-100 bg-sky-50 px-3 py-3 text-xs font-bold text-sky-700">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span>
          المحدَّدون فقط يمكنهم رؤية هذا المستودع والعمل عليه عند تفعيل نطاق المستودعات.
          المسؤولون (admin) لديهم وصول ضمني دائم ولا يحتاجون تحديدًا.
        </span>
      </div>

      <label className="relative mt-4 block">
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="field w-full pr-10"
          placeholder="بحث عن مستخدم…"
          aria-label="بحث في المستخدمين"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {scopedUsers.length === 0 && globalUsers.length === 0 ? (
        <div className="mt-4 grid place-items-center gap-2 rounded-xl border border-slate-100 bg-slate-50 p-6 text-center">
          <Users className="h-5 w-5 text-slate-400" />
          <span className="text-sm font-bold text-slate-500">لا نتائج مطابقة</span>
        </div>
      ) : (
        <div className="mt-4 max-h-80 space-y-1 overflow-y-auto rounded-xl border border-slate-100 p-2">
          {scopedUsers.map((u) => (
            <label
              key={u.id}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition hover:bg-slate-50"
            >
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  checked={selected.has(u.id)}
                  disabled={save.isPending}
                  onChange={() => toggle(u.id)}
                />
                <span>
                  <span className="block text-sm font-extrabold text-slate-800">
                    {u.fullName || u.username}
                  </span>
                  {u.fullName && (
                    <span className="block text-xs font-bold text-slate-400" dir="ltr">
                      {u.username}
                    </span>
                  )}
                </span>
              </span>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-extrabold text-slate-500">
                {ROLE_LABEL[u.role.toLowerCase()] ?? u.role}
              </span>
            </label>
          ))}
          {globalUsers.map((u) => (
            <div
              key={u.id}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 opacity-70"
            >
              <span className="flex items-center gap-3">
                <ShieldCheck className="h-4 w-4 text-teal-600" />
                <span className="text-sm font-extrabold text-slate-800">
                  {u.fullName || u.username}
                </span>
              </span>
              <span className="rounded-md bg-teal-50 px-2 py-0.5 text-[10px] font-extrabold text-teal-700">
                وصول ضمني — مسؤول
              </span>
            </div>
          ))}
        </div>
      )}

      {save.isError && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
          {save.error instanceof Error ? save.error.message : "تعذّر حفظ الصلاحيات"}
        </div>
      )}
      {savedFlash && !dirty && (
        <div className="mt-3 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-bold text-teal-700">
          تم حفظ صلاحيات الوصول.
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs font-bold text-slate-400">
          المحدَّدون: {selected.size}
        </span>
        <Button onClick={submit} disabled={save.isPending || !dirty}>
          {save.isPending ? (
            <>
              <Spinner className="h-4 w-4" /> جارٍ الحفظ…
            </>
          ) : (
            "حفظ الصلاحيات"
          )}
        </Button>
      </div>
    </div>
  );
}
