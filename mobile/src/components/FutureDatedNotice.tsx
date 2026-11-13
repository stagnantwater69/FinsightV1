import { useRef, useState } from "react";
import { View, type ViewStyle } from "react-native";
import { api } from "../lib/api";
import { recordPath } from "../lib/chatLinks";
import { useInsight } from "../lib/useInsight";
import type { FutureDatedRecord, FutureDatedRecords, RecordItem } from "../lib/types";
import { space } from "../theme/tokens";
import { IconRow, SectionTitle } from "./CoachKit";
import { Card, ErrorNote, Money, T } from "./ui";

/**
 * Records dated after today, with the way to fix each one.
 *
 * The server leaves these out of every figure and refuses new ones, so the
 * numbers on screen are already right. What a phone never said was that some
 * records are missing from them. Web replaces the page until they are fixed
 * (FutureDateGate); here it is a card, because the figures around it are
 * correct and a phone-only owner should not lose the dashboard over it.
 *
 * Renders nothing while loading, on a failed check, or when there are none:
 * the same fail-open choice web makes.
 */
export function FutureDatedNotice({
  businessProfileId,
  onOpen,
  style,
}: {
  businessProfileId: number;
  onOpen: (record: RecordItem) => void;
  style?: ViewStyle;
}) {
  const { data } = useInsight<FutureDatedRecords>("/records/future-dated", { businessProfileId }, [businessProfileId]);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const currentBusiness = useRef(businessProfileId);
  currentBusiness.current = businessProfileId;

  // `> 0`, not `=== 0`: an answer without a count is treated as none, like a failed check.
  if (!data || !(data.total > 0)) return null;

  async function open(reference: FutureDatedRecord) {
    if (opening !== null) return;
    setOpening(`${reference.type}-${reference.id}`);
    setOpenError(null);
    try {
      // EditRecord takes the whole record, so it is loaded first, through the
      // owner-scoped endpoint.
      const record = await api.get<RecordItem>(recordPath(reference.type, reference.id));
      if (currentBusiness.current !== businessProfileId) return;
      if (record.businessProfileId !== businessProfileId) {
        setOpenError("That record is not in this business.");
        return;
      }
      onOpen(record);
    } catch {
      if (currentBusiness.current === businessProfileId) {
        setOpenError("That record couldn't be opened. It may have been deleted.");
      }
    } finally {
      setOpening(null);
    }
  }

  return (
    <Card style={style}>
      <SectionTitle question="Records dated after today" icon="calendar-outline" tone="critical" />
      <T variant="caption" style={{ marginTop: space.sm }}>
        {data.total === 1 ? "1 record is" : `${data.total} records are`} dated after {data.today.slice(0, 10)} and
        left out of your totals. Open each one and change its date to today or earlier, or delete it.
      </T>
      <View style={{ marginTop: space.sm }}>
        {data.records.map((record, index) => {
          const when = record.date.slice(0, 10);
          const detail = [`Dated ${when}`, record.categoryName, record.vendor].filter(Boolean).join(" · ");
          return (
            <IconRow
              key={`${record.type}-${record.id}`}
              first={index === 0}
              icon={record.type === "expense" ? "arrow-up-outline" : "arrow-down-outline"}
              tone="neutral"
              title={record.description}
              detail={detail}
              right={<Money value={record.amount} />}
              onPress={() => void open(record)}
              accessibilityLabel={`Fix ${record.description}, dated ${when}`}
            />
          );
        })}
      </View>
      {data.truncated ? (
        <T variant="caption" style={{ marginTop: space.sm }}>
          Showing {data.records.length} of {data.total}. The rest appear as these are fixed.
        </T>
      ) : null}
      {openError ? <ErrorNote>{openError}</ErrorNote> : null}
    </Card>
  );
}
