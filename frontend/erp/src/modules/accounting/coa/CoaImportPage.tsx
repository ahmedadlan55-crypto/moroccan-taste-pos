// ── /accounting/chart-of-accounts/import ────────────────────────────────────
// Bulk import against POST /erp/gl/accounts/import.
//
// TWO THINGS THIS PAGE REFUSES TO DO QUIETLY
//
//  1. Replacement/deletion is retired. This screen can only create accounts
//     or update bilingual names; structural work uses governed routes.
//  2. It shows the parsed rows BEFORE sending them. A silent header mismatch
//     would otherwise arrive at the server as "every row is new" and clone the
//     entire chart.
//
// The `id` column is the account's real identity: keeping it in the exported
// file is what lets an edited row UPDATE rather than duplicate.

import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, FileUp, Upload } from "lucide-react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  PageHeader,
  useToast,
} from "@/shared/ui";
import { useCan } from "@/app/providers";
import { todayISO } from "@/shared/lib";
import { useT } from "@/i18n";
import { useImportGlAccounts, type CoaImportResult, type CoaImportRow } from "../api";
import { COA_BASE, MANAGE_CAP } from "./routes";
import { useCoaData } from "./useCoaData";

/** Header → CoaImportRow field. The server also accepts the Arabic headers of
 *  its own Excel export; those are passed through untouched by `rest`. */
const HEADER_MAP: Record<string, keyof CoaImportRow> = {
  id: "id",
  code: "code",
  namear: "nameAr",
  nameen: "nameEn",
  type: "type",
  parentcode: "parentCode",
  level: "level",
  kind: "kind",
  displayorder: "displayOrder",
  order: "displayOrder",
};

/** Minimal RFC-4180 line splitter: quoted fields, doubled quotes, embedded commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

interface ParseResult {
  rows: CoaImportRow[];
  headers: string[];
  errors: string[];
}

function parseCsv(text: string): ParseResult {
  // Strip the UTF-8 BOM our own export writes, or the first header never matches.
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [], headers: [], errors: ["empty"] };

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const keys = headers.map((h) => HEADER_MAP[h.toLowerCase().replace(/[\s_]/g, "")] ?? null);
  const rows: CoaImportRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, unknown> = {};
    headers.forEach((h, c) => {
      const key = keys[c];
      const raw = (cells[c] ?? "").trim();
      if (key) row[key] = raw;
      else if (raw) row[h] = raw; // let the server's own Arabic headers through
    });
    if (!row.code && !row.id) {
      errors.push(String(i + 1));
      continue;
    }
    if (row.level) row.level = Number(row.level) || 1;
    if (row.displayOrder === "") delete row.displayOrder;
    else if (row.displayOrder != null) row.displayOrder = Number(row.displayOrder);
    rows.push(row as unknown as CoaImportRow);
  }
  return { rows, headers, errors };
}

export function CoaImportPage() {
  const t = useT();
  const navigate = useNavigate();
  const canManage = useCan(MANAGE_CAP);
  const { toast } = useToast();
  const importer = useImportGlAccounts();
  const data = useCoaData();
  const fileRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<CoaImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => (text ? parseCsv(text) : null), [text]);

  function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.onerror = () => setError(t("accounting.coa.import.readFailed"));
    reader.readAsText(file, "utf-8");
  }

  function exportTemplate() {
    const header = "id,code,nameAr,nameEn,type,parentCode,kind";
    const body = data.accounts
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => {
        const parent = a.parentId ? (data.byId.get(a.parentId)?.code ?? "") : "";
        const cell = (v: string | number) => {
          const s = String(v ?? "");
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [
          cell(a.id),
          cell(a.code),
          cell(a.nameAr),
          cell(a.nameEn),
          cell(a.type),
          cell(parent),
          cell(a.isFolder ? "folder" : "leaf"),
        ].join(",");
      });
    const csv = "﻿" + [header, ...body].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `chart-of-accounts-${todayISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  }

  function submit() {
    if (!parsed || parsed.rows.length === 0) return;
    setError(null);
    setResult(null);
    importer.mutate(
      { rows: parsed.rows, mode: "update" },
      {
        onSuccess: (res) => {
          setResult(res);
          if (res && res.success === false) {
            setError(res.error || t("accounting.coa.import.failed"));
            return;
          }
          toast({ tone: "success", title: t("accounting.coa.import.done") });
        },
        // Server-side validation is Arabic today; never leak it into English
        // mode. Structured row diagnostics can be localized separately.
        onError: () => setError(t("accounting.coa.import.failed")),
      },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.coa.title")}
        title={t("accounting.coa.import.title")}
        subtitle={t("accounting.coa.import.subtitle")}
        action={
          <>
            <Button variant="secondary" onClick={exportTemplate}>
              <Download className="h-4 w-4" /> {t("accounting.coa.import.template")}
            </Button>
            <Button variant="secondary" onClick={() => navigate(COA_BASE)}>
              {t("accounting.coa.backToChart")}
            </Button>
          </>
        }
      />

      {!canManage ? (
        <Card className="p-6">
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
            {t("accounting.coa.form.noPermission")}
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t("accounting.coa.import.step1")}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <p className="text-sm font-medium leading-6 text-slate-600">
                {t("accounting.coa.import.help")}
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label={t("accounting.coa.import.chooseFile")}
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                <FileUp className="h-4 w-4" /> {t("accounting.coa.import.chooseFile")}
              </Button>
              {fileName && (
                <p className="text-xs font-bold text-slate-500" dir="ltr">
                  {fileName}
                </p>
              )}

              <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold leading-5 text-sky-800">
                {t("accounting.coa.import.safetyNote")}
              </p>

              <Button
                variant="primary"
                onClick={submit}
                loading={importer.isPending}
                disabled={!parsed || parsed.rows.length === 0}
              >
                <Upload className="h-4 w-4" />{" "}
                {t("accounting.coa.import.run", { count: parsed?.rows.length ?? 0 })}
              </Button>

              {error && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                  {error}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("accounting.coa.import.step2")}</CardTitle>
            </CardHeader>
            <CardBody>
              {!parsed ? (
                <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-medium text-slate-500">
                  {t("accounting.coa.import.noFile")}
                </p>
              ) : parsed.rows.length === 0 ? (
                <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
                  {t("accounting.coa.import.noRows")}
                </p>
              ) : (
                <>
                  <p className="mb-3 text-xs font-bold text-slate-500">
                    {t("accounting.coa.import.parsed", {
                      count: parsed.rows.length,
                      skipped: parsed.errors.length,
                    })}
                  </p>
                  <div className="max-h-[26rem] overflow-auto rounded-xl border border-slate-200">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-slate-50">
                        <tr className="text-[11px] font-extrabold text-slate-500">
                          <th className="px-3 py-2 text-start">{t("accounting.coa.col.code")}</th>
                          <th className="px-3 py-2 text-start">{t("accounting.coa.col.name")}</th>
                          <th className="px-3 py-2 text-start">{t("accounting.coa.form.parent")}</th>
                          <th className="px-3 py-2 text-start">{t("accounting.coa.col.type")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.rows.slice(0, 200).map((r, i) => (
                          <tr key={`${r.code}-${i}`} className="border-t border-slate-100">
                            <td className="px-3 py-1.5">
                              <code dir="ltr" className="text-xs tabular-nums text-slate-500">
                                {r.code}
                              </code>
                            </td>
                            <td className="px-3 py-1.5 font-bold text-slate-700">{r.nameAr}</td>
                            <td className="px-3 py-1.5 text-slate-500" dir="ltr">
                              {r.parentCode || "—"}
                            </td>
                            <td className="px-3 py-1.5 text-slate-600">
                              {r.type || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {result && result.success !== false && (
                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  {([ ["inserted", result.inserted], ["updated", result.updated], ["skipped", result.skipped] ] as const).map(([key, value]) => (
                    <div key={key} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <dt className="text-[11px] font-bold text-slate-400">
                        {t(`accounting.coa.import.result.${key}`)}
                      </dt>
                      <dd className="text-lg font-extrabold tabular-nums text-slate-800">
                        {value ?? 0}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

export default CoaImportPage;
