import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Button, T } from "./ui";
import { ResultDetails } from "./ResultDetails";
import { api } from "../lib/api";
import type { CategorySuggestion, ExpenseCategory } from "../lib/types";
import { space } from "../theme/tokens";

/** Explicit suggestions: input changes invalidate the offer, never the owner's choice. */
export function CategorySuggestionAction({ businessId, description, vendor, categories, value, onApply }: {
  businessId: number;
  description: string;
  vendor?: string;
  categories: ExpenseCategory[];
  value: number | null;
  onApply: (categoryId: number) => void;
}) {
  const input = description.trim().slice(0, 255);
  const merchant = vendor?.trim();
  const signature = `${businessId}:${input}:${merchant ?? ""}:${value ?? ""}`;
  const latest = useRef(signature);
  latest.current = signature;
  const mounted = useRef(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<{ signature: string; suggestion: CategorySuggestion | null } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function suggest() {
    if (pending.current || input.length < 3) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const result = await api.post<{ suggestion: CategorySuggestion | null }>("/ai/suggest-category", { businessProfileId: businessId, description: input, ...(merchant ? { vendor: merchant } : {}) });
      if (!mounted.current || latest.current !== signature) return;
      const suggestion = categories.some((category) => category.id === result.suggestion?.categoryId) ? result.suggestion : null;
      setOffer({ signature, suggestion });
    } catch {
      if (mounted.current && latest.current === signature) setFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const current = offer?.signature === signature ? offer : null;
  return (
    <View style={{ marginBottom: space.md, gap: space.xs }}>
      <Button title="Suggest a category" variant="ghost" onPress={() => void suggest()} disabled={input.length < 3 || busy} loading={busy} />
      {failed ? <T variant="caption">Suggestion unavailable. Choose a category yourself.</T> : null}
      {current ? current.suggestion ? (
        <>
          <T variant="label">Suggested: {current.suggestion.categoryName}</T>
          {current.suggestion.categoryId !== value ? <Button title="Apply suggestion" variant="secondary" onPress={() => {
            if (latest.current === current.signature) onApply(current.suggestion!.categoryId);
          }} /> : <T variant="caption">Matches your selected category.</T>}
          <ResultDetails label="category suggestion"><T variant="caption">Based on the description and merchant. Check that it fits this expense.</T></ResultDetails>
        </>
      ) : <T variant="caption">No clear match. Choose the category that fits best.</T> : null}
    </View>
  );
}
