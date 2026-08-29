// `/reports` — the reports home.
//
// ─── WHAT WAS HERE BEFORE ───────────────────────────────────────────────────
// `NotFound`. Every section worked (`/reports/financial`, `/reports/sales`, …)
// but the address they all hang off answered "page not found", so the sidebar
// group was a heading with no home and there was no place in the product that
// could answer "what reports exist?" — no search, no favourites, no recents.
//
// ─── WHAT DECIDES WHAT IS ON THIS PAGE ──────────────────────────────────────
// `modules/reports/registry.ts`, which DERIVES the catalogue from the eight
// section registries. Nothing is listed here. A report added to its section
// appears here on the next render with no edit to this file — which is the
// property the old hand-written Saved-Reports list lacked, and why a saved view
// on the Channels report was invisible for as long as it existed.
//
// ─── WHAT A ROW MAY CLAIM ───────────────────────────────────────────────────
// Governance badges (maturity / basis / standard) render ONLY for the reports
// whose own registry declares them — today inventory and purchasing. The rest
// show no badge rather than a flattering guess. A badge that means "we checked"
// must not appear on a report nobody checked.
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Search,
  Star,
  X,
} from "lucide-react";
import { Badge, EmptyState, PageHeader } from "@/shared/ui";
import { useLocalStorage } from "@/shared/hooks";
import { usePermissions } from "@/shared/permissions";
import { cn } from "@/shared/lib";
import { useLang, useT, type TFunction } from "@/i18n";
import {
  REPORT_CATALOG,
  REPORT_SECTIONS,
  canOpen,
  type CatalogEntry,
} from "../registry";

/** Favourites and recents are per-device conveniences, not account state. */
const FAVOURITES_KEY = "adlan.reports.favourites";
const RECENTS_KEY = "adlan.reports.recents";
const RECENTS_MAX = 8;

/** Normalize for search: fold Arabic diacritics and alef variants so a query
 *  typed without harakat still finds a title that carries them. */
function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[آأإ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .trim();
}

function useFavourites() {
  const [ids, setIds] = useLocalStorage<string[]>(FAVOURITES_KEY, []);
  const toggle = useCallback(
    (key: string) => setIds((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])),
    [setIds],
  );
  return { favourites: ids, toggle };
}

function MaturityBadge({ maturity, t }: { maturity: NonNullable<CatalogEntry["maturity"]>; t: TFunction }) {
  const tone = maturity === "authoritative" ? "success" : maturity === "conditional" ? "warning" : "neutral";
  return <Badge tone={tone}>{t(`warehouseIntelligence.assurance.maturity.${maturity}`)}</Badge>;
}

function ReportCard({
  entry,
  title,
  favourite,
  onToggleFavourite,
  onOpen,
}: {
  entry: CatalogEntry;
  title: string;
  favourite: boolean;
  onToggleFavourite: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const GoArrow = lang === "ar" ? ArrowLeft : ArrowRight;
  const Icon = entry.icon;
  return (
    <div className="group relative flex min-h-24 items-start gap-3 bg-white p-4 transition hover:bg-slate-50">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <Link
          to={entry.route}
          onClick={onOpen}
          // The whole card is the hit target, but the LINK carries the label —
          // a card-wide onClick would leave the row unreachable by keyboard.
          className="after:absolute after:inset-0 focus-visible:outline-none"
        >
          <span className="block text-sm font-extrabold text-slate-900">{title}</span>
        </Link>
        {entry.descriptionKey && (
          <span className="mt-1 block text-xs font-medium leading-5 text-slate-500">{t(entry.descriptionKey)}</span>
        )}
        {(entry.maturity || entry.standard) && (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {entry.maturity && <MaturityBadge maturity={entry.maturity} t={t} />}
            {entry.standard && <Badge tone="neutral">{t(`warehouseIntelligence.assurance.standard.${entry.standard}`)}</Badge>}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={onToggleFavourite}
        aria-pressed={favourite}
        aria-label={t(favourite ? "reportsHome.unfavourite" : "reportsHome.favourite")}
        // Above the card's ::after overlay, or the link swallows the click.
        className="relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-300 transition hover:bg-slate-100 hover:text-amber-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        <Star className={cn("h-4 w-4", favourite && "fill-amber-400 text-amber-500")} />
      </button>
      <GoArrow className="mt-2 h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-teal-600" />
    </div>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-px overflow-hidden rounded-2xl bg-slate-100 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

export default function ReportsHome() {
  const t = useT();
  const { can } = usePermissions();
  const [query, setQuery] = useState("");
  const { favourites, toggle } = useFavourites();
  const [recents, setRecents] = useLocalStorage<string[]>(RECENTS_KEY, []);

  // Resolve every title once, then search over the RESOLVED text — searching
  // the i18n key would match "salesReports.pages.voids.title" for "sales" and
  // miss "المرتجعات" entirely.
  const visible = useMemo(
    () =>
      REPORT_CATALOG.filter((entry) => canOpen(entry, can)).map((entry) => ({
        entry,
        title: t(entry.titleKey),
      })),
    [can, t],
  );

  const matches = useMemo(() => {
    const q = fold(query);
    if (!q) return visible;
    return visible.filter(({ entry, title }) => {
      const haystack = fold([title, entry.id, ...(entry.keywords ?? [])].join(" "));
      return haystack.includes(q);
    });
  }, [visible, query]);

  const byKey = useMemo(() => new Map(visible.map((v) => [v.entry.key, v])), [visible]);

  const recordOpen = useCallback(
    (key: string) => setRecents((prev) => [key, ...prev.filter((k) => k !== key)].slice(0, RECENTS_MAX)),
    [setRecents],
  );

  const favouriteRows = favourites.map((k) => byKey.get(k)).filter((v): v is NonNullable<typeof v> => !!v);
  const recentRows = recents.map((k) => byKey.get(k)).filter((v): v is NonNullable<typeof v> => !!v);
  const searching = query.trim().length > 0;

  const renderCards = (rows: typeof visible) =>
    rows.map(({ entry, title }) => (
      <ReportCard
        key={entry.key}
        entry={entry}
        title={title}
        favourite={favourites.includes(entry.key)}
        onToggleFavourite={() => toggle(entry.key)}
        onOpen={() => recordOpen(entry.key)}
      />
    ));

  return (
    <div className="space-y-5" data-testid="reports-home">
      <PageHeader title={t("reportsHome.title")} subtitle={t("reportsHome.subtitle")} />

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 start-3.5" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("reportsHome.searchPlaceholder")}
          aria-label={t("reportsHome.searchLabel")}
          className="field h-12 w-full ps-10 pe-10 text-sm font-semibold"
        />
        {searching && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t("reportsHome.clearSearch")}
            className="absolute top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 end-2"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {searching ? (
        <section aria-labelledby="reports-search-results">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="reports-search-results" className="text-sm font-extrabold text-slate-900">
              {t("reportsHome.results")}
            </h2>
            <Badge tone="neutral">{t("reportsHome.resultCount", { count: matches.length })}</Badge>
          </div>
          {matches.length === 0 ? (
            <EmptyState title={t("reportsHome.noResults")} body={t("reportsHome.noResultsBody")} />
          ) : (
            <CardGrid>{renderCards(matches)}</CardGrid>
          )}
        </section>
      ) : (
        <>
          {favouriteRows.length > 0 && (
            <section aria-labelledby="reports-favourites">
              <h2 id="reports-favourites" className="mb-2 flex items-center gap-2 text-sm font-extrabold text-slate-900">
                <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
                {t("reportsHome.favourites")}
              </h2>
              <CardGrid>{renderCards(favouriteRows)}</CardGrid>
            </section>
          )}

          {recentRows.length > 0 && (
            <section aria-labelledby="reports-recents">
              <h2 id="reports-recents" className="mb-2 flex items-center gap-2 text-sm font-extrabold text-slate-900">
                <Clock className="h-4 w-4 text-slate-400" />
                {t("reportsHome.recents")}
              </h2>
              <CardGrid>{renderCards(recentRows)}</CardGrid>
            </section>
          )}

          {REPORT_SECTIONS.map((section) => {
            const rows = matches.filter((m) => m.entry.section === section.id);
            // A section the reader cannot open ANY report in is removed, not
            // shown empty — an empty shelf reads as "broken", not "not yours".
            if (rows.length === 0) return null;
            const SectionIcon = section.icon;
            return (
              <section key={section.id} aria-labelledby={`reports-section-${section.id}`}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-slate-600">
                      <SectionIcon className="h-4 w-4" />
                    </span>
                    <div>
                      <h2 id={`reports-section-${section.id}`} className="text-sm font-extrabold text-slate-900">
                        {t(section.titleKey)}
                      </h2>
                      <p className="text-xs font-semibold text-slate-500">{t(section.descriptionKey)}</p>
                    </div>
                  </div>
                  <Link
                    to={section.route}
                    className="inline-flex min-h-9 items-center rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-600 transition hover:border-teal-300 hover:text-teal-700"
                  >
                    {t("reportsHome.openSection")}
                  </Link>
                </div>
                <CardGrid>{renderCards(rows)}</CardGrid>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
