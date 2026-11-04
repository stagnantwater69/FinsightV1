import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { InsightsTabs } from "../../components/AppShell";
import { PageHead } from "../../components/ui";

/** The heading, tabs and way back shared by Expense insight's "See all" pages. */
export function ExpenseSubpageHead({
  title,
  subtitle,
  actions,
  backTo,
}: {
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  backTo: string;
}) {
  return (
    <>
      <PageHead eyebrow="Expense insight" title={title} subtitle={subtitle} actions={actions} />
      <InsightsTabs />
      <Link to={backTo} className="tap-inline mb-4 inline-flex items-center text-sm link-action">
        <ArrowLeft aria-hidden className="mr-1.5 size-4" />
        Back to Expense insight
      </Link>
    </>
  );
}
