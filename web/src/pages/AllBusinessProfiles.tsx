import { useMemo, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { getErrorMessage } from "../lib/errors";
import { formatMoney } from "../components/Money";
import { Button, ButtonLink } from "../components/Button";
import { Avatar } from "../components/Avatar";
import { BusinessProfileFormModal } from "../components/BusinessProfileFormModal";
import { EmptyState } from "../components/EmptyState";
import { Callout, Card, PageHead, Pill } from "../components/ui";
import { TextInput } from "../components/Field";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { IconSearch } from "../components/icons";
import type { BusinessProfile } from "../lib/types";

/**
 * The full list of businesses — reached from the "View all businesses"
 * button on the Business Profiles detail page (BusinessProfiles.tsx), not
 * from the sidebar. That page shows the one business in focus; this is where
 * you compare, switch, archive, or edit any of them.
 *
 * A card grid rather than the shared <DataTable> — this list tops out at a
 * handful of businesses per owner (unlike Records, which routinely holds
 * hundreds), so the tradeoff that favors a table there — sort, dense rows,
 * scanability at volume — doesn't apply here, and a card gives each business
 * room for its logo and a quick "which one am I on" read.
 *
 * Archiving keeps its own panel below rather than becoming a card filter:
 * archived businesses are deliberately out of the way, and folding them into
 * the main grid as a greyed card invites restoring one by accident.
 */
/**
 * The one sentence that makes archiving safe to click.
 *
 * It appears twice — in the confirmation dialog and on the archived-businesses
 * panel — and the two must not drift, because an owner who is reassured in the
 * dialog and then reads something weaker afterwards has been misled.
 */
const ARCHIVE_PROMISE =
  "Nothing is deleted — all its records, insights and conversations are kept.";

export function AllBusinessProfiles() {
  const { profiles, selected, selectProfile, loading, archiveProfile, restoreProfile, listArchived } =
    useBusinessProfiles();
  const confirm = useConfirm();
  const toast = useToast();

  const [archived, setArchived] = useState<BusinessProfile[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessProfile | null>(null);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q));
  }, [profiles, keyword]);

  async function loadArchived() {
    setError(null);
    try {
      setArchived(await listArchived());
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleArchive(profile: BusinessProfile) {
    // Archiving is reversible, but it still pulls a business out of the
    // switcher — worth one confirmation, and worth saying plainly that the
    // records survive so it isn't mistaken for a delete.
    const ok = await confirm({
      title: `Archive "${profile.name}"?`,
      body: (
        <>
          It will be hidden from your list of businesses. {ARCHIVE_PROMISE} You can restore it at any
          time.
        </>
      ),
      confirmLabel: "Archive business",
      tone: "danger",
    });
    if (!ok) return;

    setBusyId(profile.id);
    setError(null);
    try {
      await archiveProfile(profile.id);
      if (archived) await loadArchived();
      toast(`Archived "${profile.name}"`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(profile: BusinessProfile) {
    setBusyId(profile.id);
    setError(null);
    try {
      await restoreProfile(profile.id);
      await loadArchived();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  // The archived panel is rendered in both the empty and populated states —
  // an owner who archives their only business must still be able to find it.
  const archivedPanel = (
    <div className="mt-8">
      {archived === null ? (
        <button
          type="button"
          onClick={loadArchived}
          className="tap rounded-lg px-3 text-sm font-medium text-ink-500 transition hover:bg-paper-100 hover:text-ink-800"
        >
          Show archived businesses
        </button>
      ) : (
        <div className="animate-slide-up rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-800">Archived businesses</h2>
            <button
              type="button"
              onClick={() => setArchived(null)}
              className="tap rounded-lg px-2 text-xs font-medium text-ink-400 transition hover:bg-paper-100 hover:text-ink-700"
            >
              Hide
            </button>
          </div>
          {archived.length === 0 ? (
            <p className="text-sm text-ink-400">You have no archived businesses.</p>
          ) : (
            <ul className="divide-y divide-paper-200">
              {archived.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-800">{p.name}</p>
                    <p className="text-xs text-ink-400">
                      {p.type}
                      {p.archivedAt ? ` · archived ${p.archivedAt.slice(0, 10)}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRestore(p)}
                    disabled={busyId === p.id}
                  >
                    {busyId === p.id ? "Restoring…" : "Restore"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-400">
            {ARCHIVE_PROMISE} Restoring one brings it back exactly as it was.
          </p>
        </div>
      )}
    </div>
  );

  const addModal = (
    <BusinessProfileFormModal
      open={addOpen}
      onClose={() => setAddOpen(false)}
      onSaved={(p) => selectProfile(p.id)}
    />
  );
  const editModal = editing ? (
    <BusinessProfileFormModal open onClose={() => setEditing(null)} profile={editing} onSaved={() => {}} />
  ) : null;

  if (loading) {
    return (
      <div>
        <PageHead eyebrow="Business Profile Management" title="Business Profiles" />
        <div className="skeleton h-64 rounded-2xl" aria-hidden />
        <span className="sr-only" aria-live="polite">
          Loading your businesses…
        </span>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div>
        <PageHead eyebrow="Business Profile Management" title="Business Profiles" />
        <EmptyState
          title="Let's set up your first business"
          action={
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              Create a business profile
            </Button>
          }
        >
          Add a business profile to start tracking its funds, expenses, and sales in FinSight.
        </EmptyState>
        {error ? <p className="mt-4 text-sm text-tone-danger">{error}</p> : null}
        {archivedPanel}
        {addModal}
      </div>
    );
  }

  return (
    <div>
      <PageHead
        eyebrow="Business Profile Management"
        title="Business Profiles"
        subtitle="One account, many businesses. Each profile keeps its own records, funds, and insights."
        actions={
          <>
            <ButtonLink to="/business-profiles" variant="secondary" size="sm">
              ← Back to current business
            </ButtonLink>
            <Button variant="brand" size="sm" onClick={() => setAddOpen(true)}>
              + Add Business Profile
            </Button>
          </>
        }
      />

      {error ? (
        <p className="mb-4 rounded-xl bg-tint-danger px-3.5 py-3 text-sm text-tone-danger ring-1 ring-edge-danger">
          {error}
        </p>
      ) : null}

      {profiles.length > 5 ? (
        <div className="relative mb-4 min-w-0 sm:max-w-xs">
          <label htmlFor="biz-search" className="sr-only">
            Search businesses
          </label>
          <IconSearch
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
          />
          <TextInput
            id="biz-search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Search businesses…"
            className="pl-9 pr-3"
          />
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState compact title="No businesses match that search" icon="⌕">
          Try a shorter word, or clear the search box.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => {
            const isActive = p.id === selected?.id;
            return (
              <Card key={p.id} className={`p-5 ${isActive ? "ring-2 ring-edge-brand" : ""}`}>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <Avatar photoUrl={p.logoUrl} label={p.name} />
                  {isActive ? <Pill tone="ok">Active</Pill> : null}
                </div>

                <h3 className="truncate text-base font-bold text-ink-900">{p.name}</h3>
                <p className="text-sm text-ink-500">{p.type}</p>

                <dl className="mt-3 space-y-1.5 border-t border-paper-200 pt-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Available Business Funds</dt>
                    <dd className="figure font-medium text-ink-900">{formatMoney(p.availableFunds)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Expected Monthly Expenses</dt>
                    <dd className="figure font-medium text-ink-900">
                      {formatMoney(p.expectedMonthlyExpenses)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Operating Days / Month</dt>
                    <dd className="figure font-medium text-ink-900">{p.operatingDays}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Records</dt>
                    <dd className="figure font-medium text-ink-900">{p.recordCount}</dd>
                  </div>
                </dl>

                <div className="mt-4 flex gap-2">
                  {isActive ? (
                    <Button variant="secondary" size="sm" fullWidth disabled>
                      Currently Active
                    </Button>
                  ) : (
                    <Button variant="brand" size="sm" fullWidth onClick={() => selectProfile(p.id)}>
                      Switch
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                </div>

                {!isActive ? (
                  <button
                    type="button"
                    onClick={() => handleArchive(p)}
                    disabled={busyId === p.id}
                    className="tap mt-2 w-full rounded-lg text-xs font-medium text-ink-400 transition hover:bg-paper-100 hover:text-tone-danger disabled:opacity-60"
                  >
                    {busyId === p.id ? "Archiving…" : "Archive"}
                  </button>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-6">
        <Callout>
          Switching the active profile updates the Dashboard, Records, Insights, Available Business Funds,
          and the context FinSight uses when suggesting categories or explaining results.
        </Callout>
      </div>

      {archivedPanel}
      {addModal}
      {editModal}
    </div>
  );
}
