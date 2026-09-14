import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "../../../lib/api";
import {
  parseReceiptProviderConsentState,
  receiptProviderConsentGrant,
  receiptProviderName,
  sameReceiptProviderTerms,
  type ActiveReceiptProviderConsent,
  type ReceiptProviderConsentState,
  type ReceiptProviderTerms,
} from "../../../lib/receiptProviderConsent";
import { describeActionFailure, toLoadFailure } from "../../../lib/connectionState";
import { useTheme } from "../../../context/ThemeContext";
import { Button, ErrorNote, T } from "../../../components/ui";
import { TAP_FLOOR } from "../../../components/touchTarget";
import { font, radius, space, typeScale } from "../../../theme/tokens";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; value: ReceiptProviderConsentState };

function Terms({ terms }: { terms: ReceiptProviderTerms | ActiveReceiptProviderConsent }) {
  const label = "label" in terms ? terms.label : receiptProviderName(terms.provider);
  const retention = `${terms.retentionHours} hour${terms.retentionHours === 1 ? "" : "s"}`;
  return (
    <View style={{ gap: 4 }}>
      <T variant="caption">FinSight sends the receipt image and a processed copy when one exists.</T>
      <T variant="caption">{label} receives it only to extract receipt fields.</T>
      <T variant="caption">Processing region: {terms.region}. Provider retention setting: {retention}.</T>
      <T variant="caption">The provider is not allowed to use it for model training. You can stop future sends here at any time.</T>
    </View>
  );
}

export function ReceiptProviderConsent({ businessProfileId }: { businessProfileId: number }) {
  const t = useTheme();
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [checked, setChecked] = useState(false);
  const [action, setAction] = useState<"grant" | "revoke" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const actionInFlight = useRef(false);
  const endpoint = `/records/receipts/provider-consent/${businessProfileId}`;

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    actionInFlight.current = false;
    setAction(null);
    setLoadState({ status: "loading" });
    setChecked(false);
    setActionError(null);
    setConfirmation(null);
    try {
      const response = await api.get<unknown>(endpoint);
      const parsed = parseReceiptProviderConsentState(response);
      if (!parsed) throw new Error("Receipt provider terms are incomplete");
      if (requestVersion.current === version) setLoadState({ status: "ready", value: parsed });
    } catch {
      if (requestVersion.current === version) setLoadState({ status: "error" });
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
    return () => {
      requestVersion.current += 1;
    };
  }, [load]);

  // The explicit path needs the checkbox ticked; the automatic re-grant is
  // one deliberate tap, since the owner already had cloud reading on by policy.
  async function grant(terms: ReceiptProviderTerms, options: { requireChecked: boolean; confirmed: string }) {
    if ((options.requireChecked && !checked) || actionInFlight.current) return;
    const version = requestVersion.current;
    actionInFlight.current = true;
    setAction("grant");
    setActionError(null);
    setConfirmation(null);
    try {
      const response = await api.put<unknown>(endpoint, receiptProviderConsentGrant(terms));
      const parsed = parseReceiptProviderConsentState(response);
      if (!parsed?.available || !parsed.provider || !parsed.consent || !sameReceiptProviderTerms(parsed.provider, terms)) {
        throw new Error("Cloud receipt settings changed.");
      }
      if (requestVersion.current !== version) return;
      setLoadState({ status: "ready", value: parsed });
      setChecked(false);
      setConfirmation(options.confirmed);
    } catch (error) {
      if (requestVersion.current === version) {
        setActionError(describeActionFailure(toLoadFailure(error), "Check the terms and try allowing it again."));
      }
    } finally {
      if (requestVersion.current === version) {
        actionInFlight.current = false;
        setAction(null);
      }
    }
  }

  async function revoke() {
    if (actionInFlight.current) return;
    const version = requestVersion.current;
    actionInFlight.current = true;
    setAction("revoke");
    setActionError(null);
    setConfirmation(null);
    try {
      const response = await api.delete<unknown>(endpoint);
      const parsed = parseReceiptProviderConsentState(response);
      if (!parsed || parsed.consent !== null || parsed.activeConsents.length !== 0) {
        throw new Error("The permission could not be confirmed as revoked.");
      }
      if (requestVersion.current !== version) return;
      setLoadState({ status: "ready", value: parsed });
      setChecked(false);
      setConfirmation("Cloud receipt permission was revoked. Future receipts use the standard reader unless you allow these terms again.");
    } catch (error) {
      if (requestVersion.current === version) {
        setActionError(describeActionFailure(toLoadFailure(error), "Try revoking the permission again."));
      }
    } finally {
      if (requestVersion.current === version) {
        actionInFlight.current = false;
        setAction(null);
      }
    }
  }

  if (loadState.status === "loading") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.md }} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={t.brandText} />
        <T variant="caption">Checking optional cloud receipt settings…</T>
      </View>
    );
  }

  if (loadState.status === "error") {
    return (
      <View style={{ gap: space.sm, paddingTop: space.md }}>
        <ErrorNote>Optional cloud receipt settings could not be checked. Receipt capture and the standard reader remain available.</ErrorNote>
        <Button title="Check optional settings again" variant="ghost" onPress={() => void load()} />
      </View>
    );
  }

  const state = loadState.value;
  // Automatic mode: the operator grants consent server-side, so there is nothing
  // for the owner to allow or revoke here, unless their own earlier revoke is
  // what keeps the policy from granting again.
  if (state.mode === "automatic") {
    if (!state.policyBlocked || !state.available || !state.provider) {
      return confirmation ? (
        <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md }}>
          <T variant="caption" accessibilityLiveRegion="polite" style={{ color: t.statusText.good }}>{confirmation}</T>
        </View>
      ) : null;
    }
    const provider = state.provider;
    return (
      <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md, gap: space.sm }}>
        <T variant="caption" accessibilityLiveRegion="polite">
          Cloud receipt reading stays off because you revoked it. Receipts use the standard reader until you allow it again.
        </T>
        <Button
          title="Allow cloud reading again"
          variant="ghost"
          loading={action === "grant"}
          onPress={() => void grant(provider, { requireChecked: false, confirmed: "Cloud receipt reading is allowed again." })}
        />
        {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
      </View>
    );
  }
  const previousOnly = state.activeConsents.length > 0 && state.consent === null;
  if (!state.available && !previousOnly && !confirmation) return null;

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.md, gap: space.sm }}>
      {previousOnly ? (
        <>
          <T variant="heading" accessibilityRole="header">Previous cloud receipt permission</T>
          <T variant="caption">
            {state.available
              ? "A permission from earlier terms is still active. Revoke it before reviewing the current terms."
              : "Optional cloud reading is off, but a permission from earlier terms is still active. Revoke it to stop future sends under that permission."}
          </T>
          {state.activeConsents.map((consent) => (
            <View key={consent.reference} style={{ gap: space.xs }}>
              <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.label }}>
                {receiptProviderName(consent.provider)}
              </T>
              <Terms terms={consent} />
            </View>
          ))}
          <Button title="Revoke future cloud sends" variant="danger" loading={action === "revoke"} onPress={() => void revoke()} />
        </>
      ) : state.available && state.provider ? (
        <>
          <T variant="heading" accessibilityRole="header">
            {state.consent ? "Optional cloud receipt help is allowed" : "Optional cloud receipt help"}
          </T>
          <T variant="caption">
            If local reading needs help, FinSight may use the provider below. Local scanning and review still work when this is off.
          </T>
          <Terms terms={state.provider} />
          {state.consent ? (
            <Button title="Revoke future cloud sends" variant="danger" loading={action === "revoke"} onPress={() => void revoke()} />
          ) : (
            <>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={`I allow FinSight to send these receipt images to ${state.provider.label} under the terms above`}
                accessibilityState={{ checked, disabled: action !== null }}
                disabled={action !== null}
                onPress={() => setChecked((value) => !value)}
                style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: space.sm }}
              >
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: radius.sm,
                    borderWidth: 2,
                    borderColor: checked ? t.brandFill : t.borderStrong,
                    backgroundColor: checked ? t.brandFill : t.surface,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {checked ? <Ionicons name="checkmark" size={18} color={t.onBrandFill} /> : null}
                </View>
                <T style={{ flex: 1, fontSize: typeScale.bodySm }}>
                  I allow FinSight to send these receipt images to {state.provider.label} under the terms above.
                </T>
              </Pressable>
              <Button
                title="Allow optional cloud help"
                variant="brand"
                disabled={!checked}
                loading={action === "grant"}
                onPress={() => void grant(state.provider!, { requireChecked: true, confirmed: "Optional cloud receipt help is allowed for these terms." })}
              />
            </>
          )}
        </>
      ) : null}
      {confirmation ? <T variant="caption" accessibilityLiveRegion="polite" style={{ color: t.statusText.good }}>{confirmation}</T> : null}
      {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
    </View>
  );
}
