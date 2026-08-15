import { PageHeader } from "@/shared/ui";
import { usePermissions } from "@/shared/permissions";
import { useT } from "@/i18n";
import { ReportDirectory, type ReportDirectoryGroup } from "../components/ReportDirectory";
import type { ReportSection } from "../engine/types";

export default function ReportsHub({ section }: { section: ReportSection }) {
  const t = useT();
  const { can } = usePermissions();
  const groups: ReportDirectoryGroup[] = section.groups
    .map((group) => ({
      id: group.id,
      title: t(group.title),
      icon: group.icon,
      items: group.links
        .filter((link) => !link.cap || can(link.cap))
        .map((link) => ({
          id: link.id,
          title: t(link.label),
          to: link.to,
          icon: link.icon,
          tone: link.tone,
        })),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div>
      <PageHeader title={t(section.title)} />
      <ReportDirectory
        groups={groups}
        openLabel={t("misc.reports.directory.open")}
        emptyLabel={t("misc.reports.directory.empty")}
      />
    </div>
  );
}
