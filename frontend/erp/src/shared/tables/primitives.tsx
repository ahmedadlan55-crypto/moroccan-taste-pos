import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/shared/lib";
import type { ColumnAlign } from "./types";

const ALIGN_CLASS: Record<ColumnAlign, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

/** Horizontal-scroll container + the table element. Keeps wide tables from
 *  forcing the page to scroll sideways. */
export function TableShell({
  children,
  className,
  scrollClassName,
}: {
  children: ReactNode;
  className?: string;
  scrollClassName?: string;
}) {
  return (
    <div className={cn("scrollbar-thin w-full overflow-x-auto", scrollClassName)}>
      <table className={cn("w-full border-collapse text-[15px]", className)}>{children}</table>
    </div>
  );
}

export function Thead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn("border-b border-slate-200 bg-slate-50/80 text-[13px]", className)}>{children}</thead>
  );
}

export function Th({
  children,
  align = "start",
  numeric,
  className,
  ...props
}: Omit<ThHTMLAttributes<HTMLTableCellElement>, "align"> & { align?: ColumnAlign; numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap px-3 py-3 font-semibold text-slate-600",
        numeric ? "text-end" : ALIGN_CLASS[align],
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "start",
  numeric,
  className,
  ...props
}: Omit<TdHTMLAttributes<HTMLTableCellElement>, "align"> & { align?: ColumnAlign; numeric?: boolean }) {
  return (
    <td
      className={cn(
        "px-3 py-3 align-middle leading-6 text-slate-700",
        numeric ? "text-end tabular-nums" : ALIGN_CLASS[align],
        numeric && "font-semibold",
        className,
      )}
      dir={numeric ? "ltr" : undefined}
      {...props}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
  clickable,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { clickable?: boolean }) {
  return (
    <tr
      className={cn(
        "border-b border-slate-100 transition last:border-0 hover:bg-slate-50/80",
        clickable && "cursor-pointer",
        className,
      )}
      {...props}
    >
      {children}
    </tr>
  );
}
