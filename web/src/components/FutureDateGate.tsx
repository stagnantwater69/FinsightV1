import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useFutureDatedRecords } from "../context/FutureDatedRecordsContext";
import { api } from "../lib/api";
import { formatCalendarDate } from "../lib/dates";
import { getErrorMessage } from "../lib/errors";
import type { FutureDatedRecord } from "../lib/types";
import { Button, ButtonLink } from "./Button";
import { useConfirm } from "./ConfirmDialog";
import { FormError } from "./Field";
import { Money } from "./Money";
import { useToast } from "./Toast";
import { Card, Tag } from "./ui";

/**
 * Pages that read or write records: blocked while any record is future-dated.
 * The two edit forms stay open because they are how a record gets fixed;
 * profile, account, business settings (a wrong timezone is one cause) and
 * notifications are untouched. Support and log out live outside the page.
 */
export function isGatedPath(pathname: string): boolean {
  if (/^\/records\/(expenses|sales)\/\d+\/edit\/?$/.test(pathname)) return false;
  return /^\/(dashboard|insights|records)(\/|$)/.test(pathname);
}

/** Renders the page, or the correction screen when this page is blocked. */
export function FutureDateGate({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { blocked, checking } = useFutureDatedRecords();
  if (!isGatedPath(pathname)) return <>{children}</>;
  // Nothing until the first answer, so a blocked page never flashes its figures.
  if (checking) return null;
  return blocked ? <FutureDateRemediation /> : <>{children}</>;
}

function recordKey(record: FutureDatedRecord) {
  return `${record.type}-${record.id}`;
}

/**
 * The correction screen. Not a dialog: it replaces the page, so there is no
 * Escape, backdrop or close button to dismiss it with. Everything outside the
 * page (navigation, the account menu with Log out) keeps working, and the
 * screen itself offers support and log out so it is never a dead end.
 */
export function FutureDateRemediation() {
  const { data, error, refresh } = useFutureDatedRecords();
  const { selected } = useBusinessProfiles();
  const { logout } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Screen-reader and keyboard users land on the explanation, not mid-page.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function remove(record: FutureDatedRecord) {
    const ok = await confirm({
      title: "Delete this record?",
      body: (
        <>
          “{record.description}”, dated {formatCalendarDate(record.date)}, is removed from your records.
        </>
      ),
      confirmLabel: "Delete record",
      tone: "danger",
    });
    if (!ok || !selected) return;
    const key = recordKey(record);
    setDeleting(key);
    setActionError(null);
    try {
      await api.delete(
        record.type === "expense" ? `/records/expenses/${record.id}` : `/records/sales/${record.id}`,
        { serverStateScope: { businessProfileId: selected.id } },
      );
      toast("Record deleted");
      await refresh();
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setDeleting(null);
    }
  }

  const total = data?.total ?? 0;

  return (
    <section aria-labelledby="future-dates-title" className="max-w-3xl">
      <div className="mb-5">
        <div className="eyebrow">Records</div>
        <h1
          id="future-dates-title"
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-bold text-ink-900 outline-none sm:text-2xl"
        >
          Fix future-dated records
        </h1>
        {data ? (
          <p className="mt-1 text-sm text-ink-600">
            {total === 1 ? "1 record is" : `${total} records are`} dated after today, {formatCalendarDate(data.today)}.
            Change each date to today or earlier, or delete the record. Records and insights are paused until then.
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="mb-4">
          <FormError>Couldn’t check your records. {error}</FormError>
          <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4">
          <FormError>{actionError}</FormError>
        </div>
      ) : null}

      {data ? (
        <Card>
          <ul aria-label="Records to fix" className="divide-y divide-paper-200">
            {data.records.map((record) => {
              const key = recordKey(record);
              const when = formatCalendarDate(record.date);
              const detail = [record.categoryName, record.vendor].filter(Boolean).join(" · ");
              return (
                <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                  {/* Full width on a phone, so the amount and actions drop to their own line. */}
                  <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Tag kind={record.type} />
                      <span className="break-words text-sm font-semibold text-ink-900">{record.description}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-600">
                      <span className="font-semibold text-tone-danger">Dated {when}</span>
                      {detail ? <> · {detail}</> : null}
                    </p>
                  </div>
                  <Money value={record.amount} decimals className="mr-auto text-sm font-semibold text-ink-900 sm:mr-0" />
                  <div className="flex gap-2">
                    <ButtonLink
                      to={record.type === "expense" ? `/records/expenses/${record.id}/edit` : `/records/sales/${record.id}/edit`}
                      variant="secondary"
                      size="sm"
                    >
                      {/* The space sits outside the span: a leading space inside it is
                          dropped from the accessible name ("EditTablet"). */}
                      Edit <span className="sr-only">{`${record.description}, dated ${when}`}</span>
                    </ButtonLink>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={deleting !== null}
                      onClick={() => void remove(record)}
                      aria-label={`Delete ${record.description}, dated ${when}`}
                    >
                      {deleting === key ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {data.truncated ? (
            <p className="border-t border-paper-200 px-4 py-3 text-xs text-ink-600 sm:px-5">
              Showing {data.records.length} of {total}. The rest appear as these are fixed.
            </p>
          ) : null}
        </Card>
      ) : !error ? (
        <p role="status" className="text-sm text-ink-600">
          Loading…
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-600">
        <span>
          Need help?{" "}
          <Link to="/contact" className="tap-inline link-action">
            Contact support
          </Link>
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void logout()}>
          Log out
        </Button>
      </div>
    </section>
  );
}
