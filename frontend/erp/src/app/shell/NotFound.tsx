import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { useT } from "@/i18n";
import { StateShell } from "@/shared/ui";

/**
 * The ONE "this route doesn't exist" screen — used by the router's catch-all and
 * by every module's dispatch fallback. It carries data-state="not-found", which
 * the closure E2E gate treats as a failure: no manifest leaf may ever render it.
 */
export function NotFound() {
  const t = useT();
  return (
    <StateShell
      state="not-found"
      icon={<Compass className="h-6 w-6" />}
      title={t("shell.notFound.title")}
      body={t("shell.notFound.body")}
      action={
        <Link className="text-sm font-bold text-teal-700 hover:underline" to="/overview">
          {t("shell.notFound.back")}
        </Link>
      }
    />
  );
}

export default NotFound;
