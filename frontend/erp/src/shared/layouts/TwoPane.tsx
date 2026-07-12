import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface TwoPaneProps {
  /** The primary (wider) pane — list / table / main content. */
  main: ReactNode;
  /** The secondary pane — filters, a summary, or a detail rail. */
  aside: ReactNode;
  /** Which side the aside sits on (start = inline-start / right in RTL). */
  asidePosition?: "start" | "end";
  /** Aside width on wide screens. */
  asideWidth?: "sm" | "md" | "lg";
  className?: string;
}

const ASIDE_W: Record<NonNullable<TwoPaneProps["asideWidth"]>, string> = {
  sm: "lg:w-64",
  md: "lg:w-80",
  lg: "lg:w-96",
};

/** Responsive two-pane split: stacks on mobile, side-by-side from `lg`. */
export function TwoPane({
  main,
  aside,
  asidePosition = "end",
  asideWidth = "md",
  className,
}: TwoPaneProps) {
  const asideEl = <aside className={cn("shrink-0", ASIDE_W[asideWidth])}>{aside}</aside>;
  return (
    <div className={cn("flex flex-col gap-4 lg:flex-row", className)}>
      {asidePosition === "start" && asideEl}
      <div className="min-w-0 flex-1">{main}</div>
      {asidePosition === "end" && asideEl}
    </div>
  );
}
