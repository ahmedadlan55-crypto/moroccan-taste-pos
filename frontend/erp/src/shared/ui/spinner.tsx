import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib";

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={cn("h-5 w-5 animate-spin text-teal-600", className)}
      role="status"
      aria-label="جارٍ التحميل"
    />
  );
}
