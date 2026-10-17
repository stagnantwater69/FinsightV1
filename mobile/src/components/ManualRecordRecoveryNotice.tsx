import { View } from "react-native";
import { Button, Callout, Money, T } from "./ui";
import { space } from "../theme/tokens";
import type { ManualRecordRecoveryState } from "../lib/useManualRecordRecovery";

export function ManualRecordRecoveryNotice({ recovery, busy, onRetry, onCheckRecords, onResolve }: {
  recovery: ManualRecordRecoveryState;
  busy: boolean;
  onRetry: () => void;
  onCheckRecords: () => void;
  onResolve: () => void;
}) {
  if (recovery.loading) return <T accessibilityLiveRegion="polite" style={{ marginBottom: space.md }}>Checking for a previous save…</T>;
  if (!recovery.intent && !recovery.error) return null;
  const payload = recovery.intent?.payload;
  const confirmed = recovery.confirmedRecordId !== null;
  return (
    <View style={{ gap: space.sm, marginBottom: space.lg }}>
      <Callout tone={confirmed ? "info" : "warn"}>
        {`${confirmed ? "Save confirmed. " : "Previous save needs checking. "}${recovery.error ?? "Check these details using the same request before editing or starting another record."}`}
      </Callout>
      {payload ? <View style={{ gap: space.xs }}>
        <T>{payload.description}</T>
        {payload.vendor ? <T variant="caption">{payload.vendor}</T> : null}
        <T variant="caption">{payload.date}</T>
        <Money value={payload.amount} decimals />
        {payload.includedInAvailableFundsBaseline !== undefined ? <T variant="caption">{payload.includedInAvailableFundsBaseline ? "Already included in the recorded balance" : "Applied after the recorded balance"}</T> : null}
        {!(confirmed && recovery.hasHeldDraft) && (!recovery.error || confirmed) ? <Button title={confirmed ? "Clear previous request" : "Retry previous save"} onPress={onRetry} loading={busy} variant="secondary" /> : null}
      </View> : <Button title="Try loading recovery again" onPress={() => void recovery.load()} disabled={busy} variant="secondary" />}
      {payload && recovery.error && !confirmed ? <Button title="Try loading recovery again" onPress={() => void recovery.load()} disabled={busy} variant="secondary" /> : null}
      {recovery.hasHeldDraft ? <T variant="caption">Your later edits are kept on this form. Start a new record to return to them.</T> : null}
      <Button title="Check records" onPress={onCheckRecords} disabled={busy} variant="secondary" />
      <Button title="Start a new record" onPress={onResolve} disabled={busy} variant="ghost" />
    </View>
  );
}
