/**
 * The records screens, as one navigable surface.
 *
 * RecordsScreens.tsx grew to well over four thousand lines holding seven
 * distinct screens — the list, both quick-add forms, the receipt scanner, the
 * CSV importer, the record editor and the flagged-records queue — plus every
 * presentational piece each of them used. Splitting it into one file per
 * screen (and, where a screen's own supporting pieces were large enough to
 * be worth naming on their own, a subdirectory for them — scanReceipt/ and
 * importCsv/, mirroring the same convention web/src/pages/scanReceipt and
 * web/src/pages/importCsv already use) is a reorganisation only: nothing
 * about what any of these screens do, look like or are called has changed.
 *
 * This barrel is what App.tsx imports from, so the screen names it registers
 * with React Navigation stay exactly what they were.
 */
export { RecordsScreen } from "./RecordsListScreen";
export { AddExpenseScreen } from "./AddExpenseScreen";
export { AddSalesScreen } from "./AddSalesScreen";
export { ScanReceiptScreen } from "./ScanReceiptScreen";
export { ImportCsvScreen } from "./ImportCsvScreen";
export { EditRecordScreen } from "./EditRecordScreen";
export { FlaggedRecordsScreen } from "./FlaggedRecordsScreen";
