// ── Journal Entries (القيود اليومية) ─────────────────────────────────────────
// The orchestrator: one screen, two modes. LIST (default) shows the filterable
// journal table; EDITOR creates a new journal or opens an existing one (posted
// journals open read-only). The route already gates on `accounting.journals.view`.

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, PageHeader } from "@/shared/ui";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";
import type { Journal } from "../api";
import { JournalList } from "../journal/JournalList";
import { JournalEditor } from "../journal/JournalEditor";

const CREATE_CAP = "accounting.journals.create" as const;

type Mode = { mode: "list" } | { mode: "edit"; journal: Journal | null };

export function JournalsPage() {
  const t = useT();
  const canCreate = useCan(CREATE_CAP);
  const [state, setState] = useState<Mode>({ mode: "list" });

  function openEditor(journal: Journal | null) {
    setState({ mode: "edit", journal });
  }
  function backToList() {
    setState({ mode: "list" });
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.eyebrow")}
        title={t("accounting.journal.title")}
        subtitle={t("accounting.journal.subtitle")}
        action={
          state.mode === "list" && canCreate ? (
            <Button variant="primary" onClick={() => openEditor(null)}>
              <Plus className="h-4 w-4" /> {t("accounting.journal.newJournal")}
            </Button>
          ) : state.mode === "edit" ? (
            <Button variant="secondary" onClick={backToList}>
              {t("accounting.journal.backToList")}
            </Button>
          ) : undefined
        }
      />

      {state.mode === "edit" ? (
        <>
          <h2 className="mb-4 text-lg font-extrabold text-slate-800">
            {state.journal ? t("accounting.journal.detailsHeading") : t("accounting.journal.newJournal")}
          </h2>
          <JournalEditor journal={state.journal} onDone={backToList} />
        </>
      ) : (
        <JournalList onOpen={openEditor} />
      )}
    </div>
  );
}

export default JournalsPage;
