import { type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { FullPageFlow } from "./full-page-flow";
import { useTx } from "./i18n";

// Compatibility API: every former side drawer is now rendered as a full-page
// work area. Keeping this API converts all modules centrally without touching
// their business logic, while preventing right-edge panels from reappearing.
export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  icon?: LucideIcon;
  children: ReactNode;
  footer?: ReactNode;
  /** Controls readable content width; the work area itself is always full-screen. */
  size?: "sm" | "md" | "lg" | "xl";
}

export function Drawer({
  open,
  onClose,
  title,
  eyebrow,
  icon,
  children,
  footer,
  size = "md",
}: DrawerProps) {
  const t = useTx();
  return (
    <FullPageFlow
      open={open}
      onClose={onClose}
      title={title}
      eyebrow={eyebrow ?? t("sharedUi.drawer.eyebrow")}
      icon={icon}
      footer={footer}
      size={size}
      layer="drawer"
    >
      {children}
    </FullPageFlow>
  );
}

export function DetailStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-[15px] font-semibold text-slate-900">{value}</div>
    </div>
  );
}
