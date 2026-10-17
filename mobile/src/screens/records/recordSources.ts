import type Ionicons from "@expo/vector-icons/Ionicons";
import type { RecordSource } from "../../lib/types";

/** How a record was added, in plainer words than the stored labels, for an owner who did not import anything themselves. */
export const SOURCE_TILES: { value: RecordSource; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: "MANUAL_ENTRY", label: "Typed in", icon: "create-outline" },
  { value: "CSV_UPLOAD", label: "CSV file", icon: "document-text-outline" },
  { value: "RECEIPT_SCAN", label: "Receipt", icon: "receipt-outline" },
];
