import { useMemo, useState, type ComponentType } from "react";
import { Eye, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/shared/lib";

export type ReportDirectoryTone = "teal" | "blue" | "amber" | "rose" | "violet" | "lime";

export interface ReportDirectoryAction {
  id: string;
  label: string;
  to: string;
  icon?: ComponentType<{ className?: string }>;
  primary?: boolean;
}

export interface ReportDirectoryItem {
  id: string;
  title: string;
  description?: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  tone?: ReportDirectoryTone;
  eyebrow?: string;
  badge?: string;
  actions?: ReportDirectoryAction[];
}

export interface ReportDirectoryGroup {
  id: string;
  title: string;
  description?: string;
  icon: ComponentType<{ className?: string }>;
  items: ReportDirectoryItem[];
}

export interface ReportDirectoryProps {
  groups: ReportDirectoryGroup[];
  searchLabel: string;
  searchPlaceholder: string;
  openLabel: string;
  countLabel: (count: number) => string;
  emptyLabel: string;
  searchable?: boolean;
  className?: string;
}

const TONES: Record<ReportDirectoryTone, { icon: string; hover: string }> = {
  teal: { icon: "bg-teal-600 text-white shadow-sm", hover: "hover:border-teal-200 hover:bg-teal-50/40" },
  blue: { icon: "bg-sky-600 text-white shadow-sm", hover: "hover:border-sky-200 hover:bg-sky-50/40" },
  amber: { icon: "bg-amber-500 text-white shadow-sm", hover: "hover:border-amber-200 hover:bg-amber-50/40" },
  rose: { icon: "bg-rose-600 text-white shadow-sm", hover: "hover:border-rose-200 hover:bg-rose-50/40" },
  violet: { icon: "bg-violet-600 text-white shadow-sm", hover: "hover:border-violet-200 hover:bg-violet-50/40" },
  lime: { icon: "bg-lime-600 text-white shadow-sm", hover: "hover:border-lime-200 hover:bg-lime-50/40" },
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().normalize("NFKD");
}

/**
 * A shared, route-first reports library.
 *
 * The directory intentionally contains only real destinations. It does not
 * manufacture a "summary" or "detail" action when the destination cannot
 * honour one. A domain may add those actions explicitly when both routes are
 * real, keeping the catalogue useful without creating decorative dead ends.
 */
export function ReportDirectory({
  groups,
  searchLabel,
  searchPlaceholder,
  openLabel,
  countLabel,
  emptyLabel,
  searchable = false,
  className,
}: ReportDirectoryProps) {
  const [query, setQuery] = useState("");
  const needle = normalize(query);
  const visibleGroups = useMemo(
    () => groups
      .map((group) => ({
        ...group,
        items: needle
          ? group.items.filter((item) => normalize(`${item.title} ${item.description ?? ""} ${item.eyebrow ?? ""}`).includes(needle))
          : group.items,
      }))
      .filter((group) => group.items.length > 0),
    [groups, needle],
  );
  const visibleTotal = visibleGroups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <section className={cn("space-y-4", className)} data-testid="report-directory">
      {searchable && <div className="surface flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <label className="relative block min-w-0 flex-1 sm:max-w-xl">
          <span className="sr-only">{searchLabel}</span>
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-11 w-full rounded-xl border border-slate-200 bg-white ps-10 pe-3 text-sm font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:ring-4 focus:ring-teal-100"
          />
        </label>
        <span className="shrink-0 self-start rounded-full bg-slate-100 px-3 py-1.5 text-xs font-extrabold text-slate-600 sm:self-auto">
          {countLabel(visibleTotal)}
        </span>
      </div>}

      {visibleGroups.length === 0 ? (
        <div className="surface px-5 py-12 text-center text-sm font-bold text-slate-500">{emptyLabel}</div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2" data-testid="report-directory-grid">
          {visibleGroups.map((group) => {
            const GroupIcon = group.icon;
            return (
              <section key={group.id} className="surface overflow-hidden" data-report-group={group.id} aria-labelledby={`report-group-${group.id}`}>
                <header className="flex min-h-[3.25rem] items-center gap-2.5 border-b border-slate-200 bg-slate-50/70 px-4 py-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-slate-700 shadow-sm ring-1 ring-slate-200">
                    <GroupIcon className="h-4.5 w-4.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <h2 id={`report-group-${group.id}`} className="text-sm font-black text-slate-950">{group.title}</h2>
                  </span>
                </header>

                <ul className="divide-y divide-slate-100 bg-white">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const tone = TONES[item.tone ?? "teal"];
                    const actions = item.actions?.length
                      ? item.actions
                      : [{ id: "open", label: openLabel, to: item.to, icon: Eye, primary: true }];
                    return (
                      <li
                        key={item.id}
                        data-report-item={item.id}
                        className={cn("grid min-h-[4.5rem] min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-x-3 border-s-2 border-transparent px-4 py-3 transition sm:grid-cols-[2.75rem_minmax(0,1fr)_auto]", tone.hover)}
                      >
                        <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-full", tone.icon)}>
                            <Icon className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <span className="group min-w-0">
                            {item.eyebrow && <span className="block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{item.eyebrow}</span>}
                            <span className="block break-words text-sm font-extrabold leading-6 text-slate-900 transition group-hover:text-teal-800">{item.title}</span>
                        </span>

                        <div className="col-span-2 mt-2 flex shrink-0 flex-wrap items-center gap-1.5 ps-14 sm:col-span-1 sm:mt-0 sm:ps-0" role="group" aria-label={item.title}>
                          {actions.map((action) => {
                            const ActionIcon = action.icon ?? Eye;
                            return (
                              <Link
                                key={action.id}
                                to={action.to}
                                data-report-action={action.id}
                                aria-label={`${action.label} — ${item.title}`}
                                className={cn(
                                  "inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2.5 text-xs font-extrabold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                                  action.primary
                                    ? "bg-teal-50 text-teal-800 hover:bg-teal-100"
                                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-800",
                                )}
                              >
                                <ActionIcon className="h-3.5 w-3.5" aria-hidden="true" />
                                {action.label}
                              </Link>
                            );
                          })}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
