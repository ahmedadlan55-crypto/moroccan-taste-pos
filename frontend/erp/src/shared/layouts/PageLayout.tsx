import type { ReactNode } from "react";
import { cn } from "@/shared/lib";
import { PageHeader } from "@/shared/ui";

export interface PageLayoutProps {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  /** Header actions (rendered on the inline-start of the title row). */
  actions?: ReactNode;
  children: ReactNode;
  /** Constrain content width for readability (default true → max-w-7xl). */
  constrained?: boolean;
  className?: string;
}

/** The standard page frame: a PageHeader over a width-constrained content column. */
export function PageLayout({
  title,
  eyebrow,
  subtitle,
  actions,
  children,
  constrained = true,
  className,
}: PageLayoutProps) {
  return (
    <div className={cn("w-full", constrained && "mx-auto max-w-7xl", className)}>
      <PageHeader eyebrow={eyebrow} title={title} subtitle={subtitle} action={actions} />
      {children}
    </div>
  );
}
