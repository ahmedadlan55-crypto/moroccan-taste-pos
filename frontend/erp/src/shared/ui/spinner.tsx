import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib";
import { useTx } from "./i18n";

export function Spinner({ className }: { className?: string }) {
  const t = useTx();
  return (
    <Loader2
      className={cn("h-5 w-5 animate-spin text-teal-600", className)}
      role="status"
      aria-label={t("common.loading")}
    />
  );
}
