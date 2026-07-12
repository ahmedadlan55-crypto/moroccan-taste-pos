import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Drawer } from "@/shared/ui";

export interface DetailDrawerLayoutProps {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  icon?: LucideIcon;
  /** Main scrollable detail content. */
  children: ReactNode;
  /** Sticky footer actions (approve / edit / close …). */
  footer?: ReactNode;
}

/**
 * A list-detail pattern helper: renders the selected record's detail inside the
 * shared accessible Drawer. Thin wrapper that standardizes the header/footer
 * shape for record detail panes across modules.
 */
export function DetailDrawerLayout({
  open,
  onClose,
  title,
  eyebrow,
  icon,
  children,
  footer,
}: DetailDrawerLayoutProps) {
  return (
    <Drawer open={open} onClose={onClose} title={title} eyebrow={eyebrow} icon={icon} footer={footer}>
      {children}
    </Drawer>
  );
}
