import { View } from "react-native";
import { T } from "../../../components/ui";
import { ResultDetails } from "../../../components/ResultDetails";
import type { ReceiptScanResult } from "./types";

/** Receipt facts read off the paper that are not form fields, shown only when any were found. */
export function PrintedDetails({ details }: { details: ReceiptScanResult["receiptDetails"] }) {
  if (!details || !Object.values(details).some((value) => value !== null)) return null;
  return (
    <View>
    <T variant="heading">As printed on the receipt</T>
    <ResultDetails label="as printed on the receipt">
      {([
        ["Currency", details.currency],
        ["Time", details.transactionTime],
        ["Subtotal", details.subtotal],
        ["Tax", details.tax],
        ["Tip", details.tip],
        ["Discount", details.discount],
        ["Payment", details.paymentMethod],
        ["Receipt number", details.receiptNumber],
      ] as const).filter(([, value]) => value !== null).map(([label, value]) => (
        <T key={label} variant="caption">{label}: {typeof value === "number" ? value.toFixed(2) : value}</T>
      ))}
    </ResultDetails>
    </View>
  );
}
