import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Pill } from "../../components/ui";
import { api } from "../../lib/api";

type ProviderKey = "gemini" | "veryfi";
type DataClass = "RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE";

interface ProviderTerms {
  key: ProviderKey;
  label: string;
  version: string;
  region: string;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: DataClass[];
  retentionHours: number;
  trainingAllowed: false;
  revocable: true;
}

interface ConsentReference {
  reference: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface ActiveConsent {
  reference: string;
  provider: string;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: DataClass[];
  region: string;
  retentionHours: number;
  trainingAllowed: boolean;
  grantedAt: string;
  revocable: true;
}

interface ProviderConsentState {
  available: boolean;
  provider: ProviderTerms | null;
  consent: ConsentReference | null;
  activeConsents: ActiveConsent[];
}

type LoadState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error" }
  | {
      status: "revoke-only";
      value: ProviderConsentState & { activeConsents: [ActiveConsent, ...ActiveConsent[]] };
    }
  | { status: "ready"; value: ProviderConsentState & { available: true; provider: ProviderTerms } };

function readyState(value: ProviderConsentState): LoadState {
  if (value.available && value.provider) {
    return { status: "ready", value: { ...value, available: true, provider: value.provider } };
  }
  if (value.activeConsents.length > 0) {
    return {
      status: "revoke-only",
      value: { ...value, activeConsents: value.activeConsents as [ActiveConsent, ...ActiveConsent[]] },
    };
  }
  return { status: "unavailable" };
}

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Google Gemini",
  veryfi: "Veryfi",
};

const DATA_CLASS_LABELS: Record<DataClass, string> = {
  RECEIPT_IMAGE: "The receipt photos you uploaded.",
  DERIVED_RECEIPT_IMAGE: "Cropped or enhanced copies FinSight made from those photos.",
};

function grantedAtLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(date);
}

export function ReceiptProviderConsent({
  businessProfileId,
  disabled = false,
}: {
  businessProfileId: number;
  disabled?: boolean;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState<"grant" | "revoke" | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "status" | "error"; text: string } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const busy = pending !== null;

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    setAccepted(false);
    setFeedback(null);
    api
      .get<ProviderConsentState>(`/records/receipts/provider-consent/${businessProfileId}`, {
        signal: controller.signal,
      })
      .then(({ data }) => {
        if (!controller.signal.aborted) setState(readyState(data));
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [businessProfileId, loadAttempt]);

  async function revoke() {
    if (busy || disabled) return;
    setPending("revoke");
    setFeedback(null);
    try {
      const { data } = await api.delete<ProviderConsentState>(
        `/records/receipts/provider-consent/${businessProfileId}`,
      );
      setState(readyState(data));
      setAccepted(false);
      setFeedback({ tone: "status", text: "Receipt-image permission revoked." });
    } catch {
      setFeedback({
        tone: "error",
        text: "FinSight could not confirm that permission was revoked. Refresh this page and check before scanning.",
      });
    } finally {
      setPending(null);
    }
  }

  if (state.status === "loading") {
    return (
      <span role="status" className="sr-only">
        Checking optional receipt-processing settings.
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-paper-200 bg-paper-50 p-3">
        <p role="status" className="min-w-0 flex-1 text-xs leading-relaxed text-ink-600">
          FinSight could not check the optional receipt setting. Standard receipt scanning is still available.
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={() => setLoadAttempt((value) => value + 1)}>
          Retry optional settings
        </Button>
      </div>
    );
  }
  if (state.status === "unavailable") {
    return feedback?.tone === "status" ? (
      <span role="status" className="sr-only">
        {feedback.text}
      </span>
    ) : null;
  }
  if (state.status === "revoke-only") {
    const headingId = `receipt-provider-heading-${businessProfileId}`;
    const multiple = state.value.activeConsents.length > 1;
    return (
      <section
        aria-labelledby={headingId}
        className="min-w-0 space-y-3 rounded-xl border border-paper-200 bg-paper-50 p-4"
      >
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 id={headingId} className="text-sm font-semibold text-ink-900">
              Previous receipt-image {multiple ? "permissions" : "permission"}
            </h2>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-600">
              Outside receipt reading is currently unavailable, so FinSight will not send new receipt images. {multiple
                ? "These permissions remain"
                : "This permission remains"} active until you revoke {multiple ? "them" : "it"}.
            </p>
          </div>
          <Pill tone="ok">Permission active</Pill>
        </div>

        <ul className="min-w-0 divide-y divide-paper-200">
          {state.value.activeConsents.map((consent) => (
            <li key={consent.reference} className="py-3 first:pt-0 last:pb-0">
              <dl className="grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="font-medium text-ink-700">Provider</dt>
                <dd className="break-words text-ink-600">
                  {PROVIDER_LABELS[consent.provider] ?? consent.provider}
                </dd>

                <dt className="font-medium text-ink-700">Permission policy</dt>
                <dd className="break-words text-ink-600">{consent.policyVersion}</dd>

                <dt className="font-medium text-ink-700">Images covered</dt>
                <dd className="min-w-0 text-ink-600">
                  <ul className="list-disc space-y-1 pl-4">
                    {consent.dataClasses.map((dataClass) => (
                      <li key={dataClass}>{DATA_CLASS_LABELS[dataClass]}</li>
                    ))}
                  </ul>
                </dd>

                <dt className="font-medium text-ink-700">Purpose</dt>
                <dd className="break-words text-ink-600">
                  Read the receipt date, merchant, total and item lines.
                </dd>

                <dt className="font-medium text-ink-700">Processing region</dt>
                <dd className="break-words text-ink-600">{consent.region}</dd>

                <dt className="font-medium text-ink-700">Provider retention</dt>
                <dd className="text-ink-600">
                  {consent.retentionHours} {consent.retentionHours === 1 ? "hour" : "hours"}
                </dd>

                <dt className="font-medium text-ink-700">Model training</dt>
                <dd className="text-ink-600">
                  {consent.trainingAllowed
                    ? "Allowed under these saved terms."
                    : "Not allowed under these saved terms."}
                </dd>

                <dt className="font-medium text-ink-700">Permission granted</dt>
                <dd className="text-ink-600">
                  <time dateTime={consent.grantedAt}>{grantedAtLabel(consent.grantedAt)}</time>
                </dd>

                <dt className="font-medium text-ink-700">Can revoke</dt>
                <dd className="text-ink-600">Yes, from this page.</dd>
              </dl>
            </li>
          ))}
        </ul>

        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-ink-600">
            This removes every active receipt-image permission saved for this business.
          </p>
          <Button type="button" variant="danger" size="sm" onClick={revoke} disabled={disabled || busy}>
            {pending === "revoke"
              ? "Revoking permission…"
              : `Revoke previous receipt-image ${multiple ? "permissions" : "permission"}`}
          </Button>
        </div>

        {feedback ? (
          <p
            role={feedback.tone === "error" ? "alert" : "status"}
            className={`text-xs leading-relaxed ${feedback.tone === "error" ? "text-tone-danger" : "text-tone-brand"}`}
          >
            {feedback.text}
          </p>
        ) : null}
      </section>
    );
  }

  const { value } = state;
  const provider = value.provider;
  const hasCurrentConsent = value.consent !== null;
  const hasEarlierConsent = value.activeConsents.some(
    (consent) => consent.reference !== value.consent?.reference,
  );
  const disclosureId = `receipt-provider-disclosure-${businessProfileId}`;

  async function grant() {
    if (!accepted || busy || disabled) return;
    setPending("grant");
    setFeedback(null);
    try {
      const { data } = await api.put<ProviderConsentState>(
        `/records/receipts/provider-consent/${businessProfileId}`,
        {
          provider: provider.key,
          policyVersion: provider.policyVersion,
          purpose: provider.purpose,
          dataClasses: [...provider.dataClasses],
          region: provider.region,
          retentionHours: provider.retentionHours,
          trainingAllowed: provider.trainingAllowed,
        },
      );
      setState(readyState(data));
      setAccepted(false);
      setFeedback({ tone: "status", text: "Permission saved for this business." });
    } catch {
      setFeedback({
        tone: "error",
        text: "FinSight could not confirm that permission was saved. Refresh this page and check before scanning.",
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-labelledby={`receipt-provider-heading-${businessProfileId}`}
      className="min-w-0 space-y-3 rounded-xl border border-paper-200 bg-paper-50 p-4"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`receipt-provider-heading-${businessProfileId}`} className="text-sm font-semibold text-ink-900">
            Optional help for hard-to-read receipts
          </h2>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-600">
            FinSight uses its standard receipt reader first. If the result still needs help, FinSight may ask {provider.label} to read the receipt images listed below, but only after you give permission for this business.
          </p>
        </div>
        <Pill tone={hasCurrentConsent ? "ok" : "neutral"}>
          {hasCurrentConsent ? "Permission active" : "Current permission off"}
        </Pill>
      </div>

      <dl id={disclosureId} className="grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="font-medium text-ink-700">Provider</dt>
        <dd className="break-words text-ink-600">{provider.label}</dd>

        <dt className="font-medium text-ink-700">Images sent</dt>
        <dd className="min-w-0 text-ink-600">
          <ul className="list-disc space-y-1 pl-4">
            <li>The receipt photos you upload.</li>
            <li>Cropped or enhanced copies FinSight makes from those photos.</li>
          </ul>
        </dd>

        <dt className="font-medium text-ink-700">Purpose</dt>
        <dd className="break-words text-ink-600">
          Read the receipt date, merchant, total and item lines when the standard reader needs help.
        </dd>

        <dt className="font-medium text-ink-700">Processing region</dt>
        <dd className="break-words text-ink-600">{provider.region}</dd>

        <dt className="font-medium text-ink-700">Provider retention</dt>
        <dd className="text-ink-600">
          {provider.retentionHours} {provider.retentionHours === 1 ? "hour" : "hours"}
        </dd>

        <dt className="font-medium text-ink-700">Model training</dt>
        <dd className="text-ink-600">Not allowed under these terms.</dd>
      </dl>

      {hasEarlierConsent ? (
        <p className="text-xs leading-relaxed text-tone-accent">
          An earlier receipt-image permission is still active. You can revoke all earlier permission below.
        </p>
      ) : null}

      {hasCurrentConsent ? (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-ink-600">
            You can remove this permission here before a future scan.
          </p>
          <Button type="button" variant="danger" size="sm" onClick={revoke} disabled={disabled || busy}>
            {pending === "revoke" ? "Revoking permission…" : "Revoke receipt-image permission"}
          </Button>
        </div>
      ) : (
        <fieldset disabled={disabled || busy} className="space-y-2">
          <label className="flex min-h-tap cursor-pointer items-start gap-3 rounded-lg border border-paper-200 bg-paper p-3 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              aria-describedby={disclosureId}
              className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            />
            <span className="min-w-0 leading-relaxed">
              I allow FinSight to send these receipt images to {provider.label} only for the purpose and terms shown above (policy {provider.policyVersion}).
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={grant} disabled={!accepted || disabled || busy}>
              {pending === "grant" ? "Saving permission…" : "Allow outside receipt reading"}
            </Button>
            {hasEarlierConsent ? (
              <Button type="button" variant="danger" size="sm" onClick={revoke} disabled={disabled || busy}>
                {pending === "revoke" ? "Revoking permission…" : "Revoke earlier permission"}
              </Button>
            ) : null}
          </div>
        </fieldset>
      )}

      {feedback ? (
        <p
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`text-xs leading-relaxed ${feedback.tone === "error" ? "text-tone-danger" : "text-tone-brand"}`}
        >
          {feedback.text}
        </p>
      ) : null}
    </section>
  );
}
