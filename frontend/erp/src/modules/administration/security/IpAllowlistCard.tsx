import { useState } from "react";
import { Network, Plus, Trash2 } from "lucide-react";
import { Button, Input, PanelTitle, StatusBadge, Toggle, useToast } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { Can } from "@/shared/permissions";
import { useT } from "@/i18n";
import { useSaveSecurityPolicies, type IpAllowlist } from "./api";

/** Editable CIDR allowlist + enable switch, wired to PUT /security-policies. */
export function IpAllowlistCard({ initial, canManage }: { initial: IpAllowlist; canManage: boolean }) {
  const t = useT();
  const { toast } = useToast();
  const save = useSaveSecurityPolicies();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [cidrs, setCidrs] = useState<string[]>(initial.cidrs);
  const [draft, setDraft] = useState("");

  const addCidr = () => {
    const v = draft.trim();
    if (!v) return;
    setCidrs((l) => (l.includes(v) ? l : [...l, v]));
    setDraft("");
  };
  const removeCidr = (c: string) => setCidrs((l) => l.filter((x) => x !== c));

  const submit = () =>
    save.mutate(
      { ipAllowlist: { enabled, cidrs } },
      {
        onSuccess: () => toast({ title: t("administration.security.ip.toastSuccess"), tone: "success" }),
        onError: (e: Error) => toast({ title: t("administration.security.ip.saveFailed"), description: e.message, tone: "error" }),
      },
    );

  return (
    <section className="surface">
      <PanelTitle
        icon={Network}
        title={t("administration.security.ip.panelTitle")}
        subtitle={t("administration.security.ip.panelSubtitle")}
        action={<StatusBadge tone={enabled ? "success" : "neutral"}>{enabled ? t("administration.security.ip.badgeEnabled") : t("administration.security.ip.badgeDisabled")}</StatusBadge>}
      />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-extrabold text-slate-900">{t("administration.security.ip.enableTitle")}</div>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              {t("administration.security.ip.enableBody")}
            </p>
          </div>
          <Toggle
            checked={enabled}
            disabled={!canManage}
            onChange={setEnabled}
            aria-label={t("administration.security.ip.enableAria")}
          />
        </div>

        {canManage && (
          <div className="flex items-end gap-2">
            <Field className="flex-1" label={t("administration.security.ip.addLabel")} hint={t("administration.security.ip.addHint")}>
              {({ id }) => (
                <Input
                  id={id}
                  value={draft}
                  dir="ltr"
                  placeholder="0.0.0.0/0"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCidr();
                    }
                  }}
                />
              )}
            </Field>
            <Button variant="secondary" onClick={addCidr}>
              <Plus className="h-4 w-4" /> {t("administration.security.ip.addBtn")}
            </Button>
          </div>
        )}

        {cidrs.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-3 py-3 text-xs font-medium text-slate-500">
            {t("administration.security.ip.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {cidrs.map((c) => (
              <li
                key={c}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2"
              >
                <span dir="ltr" className="text-sm tabular-nums text-slate-800">
                  {c}
                </span>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => removeCidr(c)}
                    aria-label={t("administration.security.ip.removeAria", { cidr: c })}
                    className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <Can cap="administration.security.manage">
          <div className="flex justify-end">
            <Button onClick={submit} loading={save.isPending}>
              {t("administration.security.ip.saveBtn")}
            </Button>
          </div>
        </Can>
      </div>
    </section>
  );
}
