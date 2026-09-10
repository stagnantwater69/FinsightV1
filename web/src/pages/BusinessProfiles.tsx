import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { formatMoney } from "../components/Money";
import { ButtonLink } from "../components/Button";
import { StatTile } from "../components/StatTile";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { PageHead, Panel, Pill } from "../components/ui";

/**
 * Business profile — the ONE business currently in focus, not a list.
 *
 * This used to be a table of every business the owner has, which put the
 * business they're actually looking at on equal footing with every other one
 * they're not — a search box and five sortable columns to answer "what's my
 * available funds again?" about the business already selected in the sidebar.
 *
 * That comparison view still exists — AllBusinessProfiles.tsx, one click away
 * via "View all businesses" — but it's for a different question ("which of my
 * businesses needs attention", "let me switch to another one"), not this
 * page's question ("what does THIS business's profile actually say").
 */
export function BusinessProfiles() {
  const { selected, loading } = useBusinessProfiles();

  if (loading) {
    return (
      <div>
        <PageHead eyebrow="Management" title="Business profile" />
        <div className="skeleton h-64 rounded-2xl" aria-hidden />
        <span className="sr-only" aria-live="polite">
          Loading your business profile…
        </span>
      </div>
    );
  }

  if (!selected) {
    return (
      <div>
        <PageHead eyebrow="Management" title="Business profile" />
        <EmptyState
          image="/mascot/01-onboarding/businessprofilesetup.webp"
          title="Let's set up your first business"
          action={
            <ButtonLink to="/business-profiles/new" variant="primary">
              Create a business profile
            </ButtonLink>
          }
        >
          Add a business profile to start tracking its funds, expenses, and
          sales in FinSight.
        </EmptyState>
      </div>
    );
  }

  const threshold =
    Number(selected.expectedMonthlyExpenses) *
    (selected.largeExpenseThresholdPercent / 100);
  const dailyTarget =
    selected.operatingDays > 0
      ? Number(selected.expectedMonthlyExpenses) / selected.operatingDays
      : 0;

  return (
    <div>
      <PageHead
        title="Business profile"
        subtitle="What FinSight knows about the business you're currently looking at."
        actions={
          <>
            <ButtonLink
              to="/business-profiles/all"
              variant="secondary"
              size="sm"
            >
              View all businesses
            </ButtonLink>
            <ButtonLink
              to={`/business-profiles/${selected.id}/edit`}
              variant="brand"
              size="sm"
            >
              Edit business
            </ButtonLink>
          </>
        }
      />

      <Panel
        title={
          <span className="flex items-center gap-3">
            <Avatar photoUrl={selected.logoUrl} label={selected.name} />
            {selected.name}
          </span>
        }
        eyebrow={selected.type}
        action={<Pill tone="ok">Active business</Pill>}
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatTile
            label="Available business funds"
            value={formatMoney(selected.availableFunds)}
            sublabel="Owner-entered reference"
            emphasis
          />
          <StatTile
            label="Expected monthly expenses"
            value={formatMoney(selected.expectedMonthlyExpenses)}
            sublabel="Owner-entered reference"
          />
          <StatTile
            label="Operating days / month"
            value={String(selected.operatingDays)}
            sublabel="Owner-entered reference"
          />
          <StatTile
            label="Daily sales target"
            value={formatMoney(dailyTarget)}
            sublabel="Expected expenses ÷ operating days"
          />
          <StatTile
            label="Large-expense threshold"
            value={`${selected.largeExpenseThresholdPercent}%`}
            sublabel={
              <>
                = <span className="figure">{formatMoney(threshold)}</span> of
                expected monthly expenses
              </>
            }
          />
        </div>

        <div className="mt-5 grid gap-4 border-t border-paper-200 pt-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div>
            <p className="text-sm font-semibold text-ink-800">
              How FinSight uses this profile
            </p>
            <p className="mt-1 max-w-4xl text-sm leading-relaxed text-ink-500">
              These owner-entered figures shape recovery calculations, daily
              targets, spending context, and which expenses are flagged for
              review. Profile created {selected.createdAt.slice(0, 10)}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonLink to="/insights/recovery" variant="secondary" size="sm">
              View recovery target
            </ButtonLink>
            <ButtonLink to="/records" variant="secondary" size="sm">
              Review records
            </ButtonLink>
          </div>
        </div>
      </Panel>
    </div>
  );
}
