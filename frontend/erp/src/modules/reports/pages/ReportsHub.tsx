import { PageHeader } from "@/shared/ui";
import { usePermissions } from "@/shared/permissions";
import { useT } from "@/i18n";
import { ReportDirectory, type ReportDirectoryGroup } from "../components/ReportDirectory";
import type { ReportSection } from "../reportLinks";

export default function ReportsHub({ section }: { section: ReportSection }) {
  const t = useT();
  const { can } = usePermissions();
  const groups: ReportDirectoryGroup[] = section.groups
    .map((group) => ({
      id: group.id,
      title: t(group.title),
      description: t(group.description),
      icon: group.icon,
      items: group.links
        .filter((link) => !link.cap || can(link.cap))
        .map((link) => ({
          id: link.id,
          title: t(link.label),
          description: t(link.description),
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
        searchLabel={t("misc.reports.directory.searchLabel")}
        searchPlaceholder={t("misc.reports.directory.searchPlaceholder")}
        openLabel={t("misc.reports.directory.open")}
        countLabel={(count) => t("misc.reports.directory.count", { count })}
        emptyLabel={t("misc.reports.directory.empty")}
      />
    </div>
  );
}
