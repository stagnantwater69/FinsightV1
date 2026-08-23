import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { Button, Card, ErrorNote, Field, Money, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, errorMessage } from "../../lib/api";
import {
  buildItemisedConfirmPayload,
  buildReceiptConfirmPayload,
  gapCentavos,
  type ReconciliationPlan,
} from "../../lib/receiptConfirm";
import { rowsToApplySuggestionTo, suggestedNewCategory } from "../../lib/categorySuggestion";
import { BAND_COPY, confidenceBand, needsAttention, scanConfidenceBand } from "../../lib/confidenceBands";
import {
  evidenceSummary,
  fieldsNeedingAttention,
  warningHeadline,
  warningPageSuffix,
  warningTone,
} from "../../lib/receiptWarnings";
import { ReceiptCamera } from "../../components/receipt-camera";
import { takeHandedOffSections } from "../../lib/receiptHandoff";
import { canAddSection, CAPTURE_QUALITY } from "../../lib/receiptCapture";
import { setFlash } from "../../lib/flash";
import { SkeletonBox } from "../../components/Skeleton";
import { DateField } from "../../components/DateField";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../../lib/haptics";
import { TAP, font, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { CategoryPicker, todayISO } from "./shared";
import { ScanBand } from "./scanReceipt/ScanBand";
import { ReviewNotices } from "./scanReceipt/ReviewNotices";
import { ReviewSection } from "./scanReceipt/ReviewSection";
import { EvidenceNote } from "./scanReceipt/EvidenceNote";
import { CategoryChips } from "./scanReceipt/CategoryChips";
import { GapOption } from "./scanReceipt/GapOption";
import { pollUntilRead, pagesFromSections, sectionsFromPages } from "./scanReceipt/helpers";
import type { CapturedPage, ReceiptScanResult, ReviewNotice } from "./scanReceipt/types";

/**
 * Capture in FinSight's own camera → approve each section → upload to the
 * existing backend receipt endpoint → editable review → confirm.
 *
 * WHAT THE CAMERA CHANGED, AND WHAT IT DID NOT. Photographs now come from
 * components/receipt-camera rather than from the system camera app: a receipt
 * frame to line the paper up in, a section counter that says these are parts
 * of ONE receipt, an overlap guide for long ones, an approval step before
 * anything is uploaded, and a crop editor. None of that reaches the server.
 * `scanPages` below sends the same `files` array in the same order to the
 * same endpoint it always has — see pagesFromSections for the seam. The
 * gallery path is untouched and remains the fallback for a phone whose owner
 * will not grant camera access.
 *
 * SECTION 0 DECISION: OCR runs SERVER-SIDE (Tesseract, already built and
 * accuracy-measured at 100% date / 95% vendor / 100% amount on a 20-image
 * corpus). Google ML Kit's on-device OCR needs native modules that don't run in
 * Expo Go, so adopting it would mean a dev-client or bare-workflow migration —
 * a large change for a capability the backend already provides and that has
 * measured accuracy behind it. On-device OCR is documented as a future
 * improvement instead.
 *
 * THE SAME CONSTRAINT DECIDED EDGE DETECTION. Every way of finding a
 * receipt's corners on the phone — a document-scanner library, a custom
 * native module, OpenCV — needs a development build for exactly the reason
 * ML Kit did. So detection runs server-side, after the shutter, on the same
 * still the readability check already looks at, and it only ever proposes
 * corners the owner drags. Nothing is detected from live frames, which is why
 * there is no real-time outline and no automatic shutter.
 *
 * The one real difference from a browser upload: a phone camera returns a large,
 * possibly rotated JPEG. That is exactly why the review step below is editable
 * and nothing is saved until the owner confirms.
 *
 * Its own supporting types, poll helper and capture-session conversions live
 * in ./scanReceipt/ — this file is the screen itself.
 */
export function ScanReceiptScreen({ navigation }: any) {
  const t = useTheme();
  const { brand, ink, paper, statusText } = t;
  const { selected, categories, refreshCategories, createCategory } = useBusinessProfiles();
  const [scan, setScan] = useState<ReceiptScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Photos captured so far in this session, before the receipt is scanned.
   *
   * A long receipt is photographed a page at a time via `capturePage`, which
   * appends here rather than uploading immediately — the whole session is
   * sent as one scan only once the owner taps "Scan this receipt". A single
   * photo is simply a one-page session; there is no separate code path for
   * the common case.
   */
  /**
   * Sections photographed in the tab bar's camera before this screen existed.
   *
   * Taken once, in a lazy initialiser, because `takeHandedOffSections` clears
   * as it reads — calling it during an ordinary render would consume the
   * session on the first render and find nothing on the second.
   */
  const [handedOff] = useState(() => takeHandedOffSections());

  const [pages, setPages] = useState<CapturedPage[]>(() =>
    handedOff ? pagesFromSections(handedOff) : [],
  );

  /**
   * Whether FinSight's own camera is up.
   *
   * Open unless the owner arrives with photographs already taken. There are
   * two ways in and they want opposite things:
   *
   *   - from the tab bar's Scan button, the camera has ALREADY run and handed
   *     its sections over; reopening it here would put a viewfinder in front
   *     of someone who has just finished photographing;
   *   - from "Scan receipt" on the records list, nothing has been captured,
   *     and the screen's whole purpose is to capture something. Landing on a
   *     card whose only content is a button saying "Open the camera" asks
   *     someone to confirm the thing they just asked for.
   *
   * A full-screen state rather than a route of its own, so backing out of the
   * camera is this screen's decision to make (see `onCancel`) rather than
   * something the Android back button and the header's back arrow each get
   * their own opinion about. It also means the preview unmounts the moment
   * this flips false, which keeps the sensor and torch from running behind
   * the review form.
   */
  const [cameraOpen, setCameraOpen] = useState(handedOff === null);

  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");

  /**
   * The owner's category for each extracted line, keyed by item id.
   *
   * Seeded from what the server assigned automatically, then owned by the
   * owner — every row is editable and nothing is written until Confirm.
   */
  const [itemCategories, setItemCategories] = useState<Record<number, number | null>>({});
  /** How they want to account for any difference between items and total. */
  const [plan, setPlan] = useState<ReconciliationPlan>(null);
  /** The category for the "file it on its own" plan. */
  const [gapCategoryId, setGapCategoryId] = useState<number | null>(null);
  /** The proposed category currently being created, so its row can show progress. */
  const [creatingCategoryFor, setCreatingCategoryFor] = useState<string | null>(null);
  /**
   * Lines the owner is adding because OCR missed them.
   *
   * Held here until Confirm, like every other answer on this screen — nothing
   * is written until they accept the whole receipt.
   */
  const [addedItems, setAddedItems] = useState<
    { key: string; name: string; amount: string; categoryId: number | null }[]
  >([]);
  /** The extracted line currently being removed, so its row can show progress. */
  const [removingItemId, setRemovingItemId] = useState<number | null>(null);

  /** The review form's chain: Description → Vendor → Amount. */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);
  /**
   * The added-item rows chain within themselves — name hands off to the
   * amount on the SAME row, never to the next row's.
   *
   * One ref per row, held in a map keyed by the row's own `key`, because the
   * rows are produced by a `.map()`: a single shared ref would be overwritten
   * by every row rendered after the first, and typing in row one would jump
   * the cursor to the bottom of the receipt. The callback clears its entry on
   * unmount so removing a row does not leave a dead node behind.
   */
  const addedAmountRefs = useRef<Record<string, TextInput | null>>({});

  /*
   * The camera never outlives this screen.
   *
   * Opening the Modal does not blur the screen — it is part of it — so this
   * cleanup only fires when the owner genuinely navigates away: a tab press
   * that pops the stack, a notification, a deep link. Without it an
   * unmounting screen could leave an Android modal window behind with no
   * component left to close it, which shows up as an app that has quietly
   * become unresponsive.
   */
  useFocusEffect(useCallback(() => () => setCameraOpen(false), []));

  /*
   * A handed-over session is already photographed and already approved — the
   * owner pressed "Scan" on the capture preview, not "hold this for me". So
   * the read starts on arrival rather than behind one more button on a screen
   * that would otherwise show them their own photographs and ask again.
   *
   * Mount-only. `scanPages` is given the pages explicitly because the state
   * holding them was set in the same render this effect follows, and reading
   * it through the closure would be reading it before React has committed.
   */
  useEffect(() => {
    if (handedOff && handedOff.length > 0) void scanPages(pagesFromSections(handedOff));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!selected) return null;

  /**
   * Adds one photograph to the session and checks its own readability
   * immediately — the point of doing this now rather than after the whole
   * set uploads is that catching a blurry PAGE 2 while the camera is still
   * open costs a tap, and catching it after costs an OCR pass, a possible
   * vision call, and a wrong set of figures the owner has to notice and undo.
   *
   * The check runs against a DIFFERENT, lightweight endpoint
   * (/records/receipts/quality-check) that does no OCR and writes nothing —
   * it exists purely so this can be cheap enough to fire on every shutter
   * press. Failing silently here is deliberate: a blur check that could not
   * run is a missed nicety, not a reason to stop the owner from adding the
   * page they just photographed.
   */
  async function addPage(asset: ImagePicker.ImagePickerAsset) {
    const key = `${Date.now()}-${Math.random()}`;
    const uri = asset.uri;
    const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;
    const mimeType = asset.mimeType ?? "image/jpeg";
    setPages((prev) => [
      ...prev,
      {
        key,
        uri,
        fileName,
        mimeType,
        quality: null,
        checkingQuality: true,
        width: asset.width,
        height: asset.height,
      },
    ]);
    setError(null);

    try {
      const form = new FormData();
      // React Native's FormData takes this {uri,name,type} shape rather than
      // a Blob — the browser's File API isn't available here.
      form.append("file", { uri, name: fileName, type: mimeType } as any);
      const quality = await api.upload<CapturedPage["quality"]>("/records/receipts/quality-check", form);
      setPages((prev) => prev.map((p) => (p.key === key ? { ...p, quality, checkingQuality: false } : p)));
    } catch {
      setPages((prev) => prev.map((p) => (p.key === key ? { ...p, checkingQuality: false } : p)));
    }
  }

  function removePage(key: string) {
    setPages((prev) => prev.filter((p) => p.key !== key));
  }

  /** Moves a page earlier (delta -1) or later (delta +1) in the sequence. */
  function movePage(key: string, delta: number) {
    setPages((prev) => {
      const index = prev.findIndex((p) => p.key === key);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }

  /**
   * Sends every captured page as ONE scan. A single photo is simply a
   * one-element page list — there is no separate upload path for it.
   */
  async function scanPages(list: CapturedPage[] = pages) {
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("businessProfileId", String(selected!.id));
      // "files" — plural — repeated once per page: the server has one
      // upload route for both a single photo and a long receipt's pages,
      // and it reads this field name for either.
      for (const p of list) {
        form.append("files", { uri: p.uri, name: p.fileName, type: p.mimeType } as any);
      }

      const accepted = await api.upload<ReceiptScanResult>("/records/receipts", form);
      // The upload returns as soon as the photos are stored; the read itself
      // finishes behind it. See pollUntilRead.
      const result = await pollUntilRead(accepted);
      setScan(result);
      // Pre-fill from OCR — as a draft the owner checks, never as truth.
      if (result.extractedDate) setDate(String(result.extractedDate).slice(0, 10));
      if (result.extractedVendor) setVendor(result.extractedVendor);
      if (result.extractedDescription) setDescription(result.extractedDescription);
      /*
        Two decimal places, always. `String(1475.5)` is "1475.5", which reads
        as an amount somebody typed carelessly rather than one read off a
        receipt — and it is the field the owner is asked to check against
        printed centavos.
      */
      if (result.extractedAmount != null) setAmount(result.extractedAmount.toFixed(2));
      // Seed the per-item categories from what FinSight assigned. A starting
      // point, not a decision — every row stays editable below.
      setItemCategories(
        Object.fromEntries((result.items ?? []).map((i) => [i.id, i.categoryId ?? null])),
      );
      setPlan(null);
      setGapCategoryId(null);
      // A vision-assisted read is a guess, not a reading — it deserves a
      // different signal from a clean scan, so the owner is primed to check
      // it before they even look down.
      if (result.visionAssisted) {
        haptics.warned();
      } else {
        haptics.succeeded();
      }
    } catch (err) {
      haptics.failed();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Opens FinSight's own camera.
   *
   * Permission is NOT requested here any more. The camera screen owns that
   * conversation, because it is the thing that can explain what the camera is
   * for, offer the gallery instead, and point at Settings once the system has
   * stopped asking — none of which a one-line error on this card could do.
   */
  function capturePage() {
    haptics.committed();
    setError(null);
    setCameraOpen(true);
  }

  /**
   * The gallery fallback, unchanged in behaviour and deliberately kept.
   *
   * A receipt someone already photographed, a screenshot of an e-receipt, and
   * a phone whose owner will not grant camera access are all real, and none
   * of them is served by a scanner. This is also the path that keeps working
   * if anything about the new camera turns out to be wrong on a device — the
   * reason it was preserved before the camera was touched at all.
   *
   * Quality is raised to match the camera's: it is the same OCR reading the
   * same faint thermal print, and there is no reason a gallery image should
   * arrive more compressed than a captured one.
   */
  async function pickPage() {
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: CAPTURE_QUALITY,
      mediaTypes: ["images"],
    });
    if (!res.canceled && res.assets[0]) await addPage(res.assets[0]);
  }

  /*
   * Two review modes, exactly as web has.
   *
   * A receipt whose lines FinSight could read is reviewed ITEM BY ITEM — that
   * is the point of the feature, and it is what lets "buns" land in
   * Ingredients while "rice cooker" lands in Equipment without the owner
   * deciding anything up front. A receipt with one line or none keeps the
   * single-category flow: a grouping UI for one item would be ceremony around
   * a decision the category picker already makes.
   */
  const items = scan?.items ?? [];
  const isItemised = items.length > 1;
  /** An added line only counts once it is actually usable. */
  const usableAddedItems = addedItems.filter(
    (a) => a.name.trim() !== "" && Number(a.amount) > 0 && a.categoryId != null,
  );
  // Added lines count toward the items' total the moment they are complete, so
  // adding a missed line closes the gap immediately rather than after saving.
  const itemsTotal =
    items.reduce((sum, i) => sum + i.amount, 0) +
    usableAddedItems.reduce((sum, a) => sum + Number(a.amount), 0);
  const totalValue = Number(amount);
  const gap = Number.isFinite(totalValue) ? gapCentavos(totalValue, itemsTotal) : 0;
  const everyItemHasCategory =
    items.every((i) => itemCategories[i.id] != null) &&
    // A half-typed added row must not enable Confirm.
    addedItems.length === usableAddedItems.length;
  // A discount can't become its own expense record — that would be a negative
  // expense, which nothing downstream understands. The server refuses it too.
  const canFileGapOnItsOwn = gap > 0;
  const planResolved =
    gap === 0 ||
    plan === "proportional" ||
    plan === "shrink" ||
    (plan === "category" && canFileGapOnItsOwn && gapCategoryId != null);

  async function confirm() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (isItemised) {
      if (!everyItemHasCategory) return setError("Every item needs a category before this can be saved.");
      if (!planResolved) return setError("Choose how to account for the difference first.");
    } else if (!categoryId) {
      return setError("Choose a category first.");
    }

    setBusy(true);
    setError(null);
    try {
      // Both shapes and their rules live in lib/receiptConfirm, where they can
      // be tested against the server's schema — this call is what silently
      // broke against it before.
      const payload = isItemised
        ? buildItemisedConfirmPayload({
            date,
            description,
            vendor,
            totalAmount: value,
            itemsTotal,
            itemAssignments: items.map((i) => ({ itemId: i.id, categoryId: itemCategories[i.id]! })),
            additionalItems: usableAddedItems.map((a) => ({
              name: a.name.trim(),
              amount: Number(a.amount),
              categoryId: a.categoryId!,
            })),
            plan,
            gapCategoryId,
          })
        : buildReceiptConfirmPayload({ date, description, vendor, amount: value, categoryId: categoryId! });

      await api.post(`/records/receipts/${scan!.id}/confirm`, payload);
      haptics.succeeded();
      setFlash("Receipt saved to your records.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The standing "nothing fitted this" category, if this business has one.
   *
   * Created server-side on demand during a scan, so it may not exist at all,
   * and matched case-insensitively because an owner who already had their own
   * keeps it — the same rule the server follows.
   */
  const uncategorisedId = categories.find((c) => c.name.toLowerCase() === "uncategorized")?.id ?? null;

  /** See lib/categorySuggestion — the rule has edge cases worth testing. */
  function suggestedNewCategoryFor(item: { id: number; suggestedCategoryName?: string | null }): string | null {
    return suggestedNewCategory(
      item,
      itemCategories[item.id] ?? null,
      uncategorisedId,
      categories.map((c) => c.name),
    );
  }

  /**
   * Accepts a category FinSight proposed for items nothing existing fitted.
   *
   * Creates it, then files every UNPLACED row it was proposed for — not only
   * the row that was tapped. A grocery run proposes "Packaging" on all four
   * packaging lines, and making the owner create it once then assign it three
   * more times by hand would be busywork on a decision already made. Rows they
   * placed themselves are left alone, and everything stays editable.
   */
  async function acceptSuggestedCategory(name: string) {
    setCreatingCategoryFor(name);
    setError(null);
    try {
      // createCategory puts the new row into the shared list itself, so the
      // refreshCategories() that used to follow this is gone — it was a second
      // round trip to learn what the response already said.
      const created = await createCategory({ name });
      setItemCategories((prev) => {
        const next = { ...prev };
        for (const id of rowsToApplySuggestionTo(items, name, prev, uncategorisedId)) {
          next[id] = created.id;
        }
        return next;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreatingCategoryFor(null);
    }
  }

  /**
   * Drops a line OCR read that was never a purchase.
   *
   * Deleted on the SERVER rather than hidden here, because confirmation
   * requires every stored item to carry a category — a row this screen merely
   * stopped showing would still be on the scan and would block Confirm with a
   * message about an item the owner can no longer see.
   *
   * Widening the gap against the total is the intended consequence, not a
   * side effect: the reconciliation question below already exists to answer
   * exactly that.
   */
  async function removeScannedItem(itemId: number) {
    if (!scan) return;
    setRemovingItemId(itemId);
    setError(null);
    try {
      const updated = await api.delete<ReceiptScanResult>(`/records/receipts/${scan.id}/items/${itemId}`);
      setScan(updated);
      setItemCategories((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRemovingItemId(null);
    }
  }

  /**
   * Everything worth checking about this reading, in the order it matters.
   *
   * TWO SOURCES, AND ONLY ONE OF THEM AT A TIME.
   *
   * The server now emits machine-readable warning CODES, each carrying its
   * own actionable sentence (`guidance`). When a scan has them, they ARE this
   * list and their wording is the server's — which is the whole point of the
   * contract: the app and the website used to write their own prose for the
   * same signals, and the two had already drifted apart. A client that
   * rewrites a sentence here re-creates that bug.
   *
   * The hand-derived notices below it are the fallback for scans read before
   * warnings were recorded. They are NOT merged with the codes: a blurry page
   * reported once by the server and once by this screen reads as two separate
   * problems with the same photograph.
   *
   * The ORDER, in both cases, is the argument: the photograph comes first
   * because it has the cheapest answer on the screen and the camera is one tap
   * away, then the things that make figures wrong, then the things that only
   * make them uncertain.
   */
  /**
   * The one cue at the top: how much of this reading to doubt.
   *
   * Derived from the page reading, every item amount and whether a model was
   * involved — a receipt is only as clear as its worst part, and a scan whose
   * page read cleanly but whose amounts did not is not "clear".
   */
  const scanBand = scanConfidenceBand({
    ocrConfidence: scan?.ocrConfidence,
    visionAssisted: scan?.visionAssisted,
    items: scan?.items,
  });

  /**
   * The fields the server's warnings actually point at, in form order.
   *
   * This is what turns "Check a few fields" into something the owner can act
   * on — naming the two that need looking at beats asking them to re-read all
   * four.
   */
  const attentionFields = fieldsNeedingAttention(scan?.warnings ?? []);

  const reviewNotices: ReviewNotice[] = (() => {
    if (!scan) return [];

    const warnings = scan.warnings ?? [];
    if (warnings.length > 0) {
      return warnings.map((w) => ({
        tone: warningTone(w.code),
        text: [
          `${warningHeadline(w.code)}${warningPageSuffix(w)}.`,
          // Verbatim, or nothing — a code this build has no guidance for is
          // shown with its evidence rather than with an invented instruction.
          w.guidance ?? "",
          w.detail ? `(${w.detail})` : "",
        ]
          .filter(Boolean)
          .join(" "),
      }));
    }

    const notices: ReviewNotice[] = [];

    if (scan.captureQuality?.tooBlurredToTrust) {
      notices.push({
        tone: "warn",
        text:
          "This photo came out blurry. FinSight read it anyway, but blurred print is where it makes the " +
          "most mistakes — if you still have the receipt, taking another picture is usually quicker than " +
          "correcting the figures below.",
      });
    }

    // Page 1's own reading is already covered by captureQuality above.
    const blurryPages = (scan.pageQualities ?? [])
      .map((q, i) => (q?.tooBlurredToTrust ? i + 1 : null))
      .filter((n): n is number => n !== null && n !== 1);
    if ((scan.pageQualities?.length ?? 0) > 1 && blurryPages.length > 0) {
      notices.push({
        tone: "warn",
        text:
          `Page${blurryPages.length === 1 ? "" : "s"} ${blurryPages.join(", ")} came out blurry. Check the ` +
          `figures from ${blurryPages.length === 1 ? "that page" : "those pages"} carefully below.`,
      });
    }

    const duplicates = scan.duplicatePages ?? [];
    if (duplicates.length > 0) {
      notices.push({
        tone: "warn",
        text:
          `Page${duplicates.length === 1 ? "" : "s"} ${duplicates.map((p) => `${p - 1} and ${p}`).join(", ")} ` +
          "look the same. If one is a repeat photo of the other, the figures below may be double-counted — " +
          "check the items against the photos, or rescan without the repeat.",
      });
    }

    /*
     * Suppressed when duplicatePages already fired: a page flagged as a
     * repeat of its neighbour will also, necessarily, overlap it, and two
     * remarks about one pair of photographs read as two separate problems.
     */
    const overlaps = scan.overlappingPages ?? [];
    if (overlaps.length > 0 && duplicates.length === 0) {
      notices.push({
        tone: "info",
        text:
          `Section${overlaps.length === 1 ? "" : "s"} ${overlaps.map((p) => `${p - 1} and ${p}`).join(", ")} ` +
          "share a few lines, which is the overlap the camera asked for. FinSight counted them once. If you " +
          "see a line twice below, delete the repeat.",
      });
    }

    if (scan.looksLikeMultipleReceipts) {
      notices.push({
        tone: "warn",
        text:
          "This photo may hold two receipts. If it does, saving now would put both purchases into one " +
          "record and the items won't add up to the total. Photograph each receipt on its own and they'll " +
          "be recorded separately — if it really is one receipt, carry on.",
      });
    }

    /*
     * Three-way split, same as the web confirm screen. The amounts on a
     * merely vision-ASSISTED read were still read off the paper and add up to
     * the printed total; only the wording came from a model. Showing the
     * stronger warning there would be false, and false in the direction that
     * teaches owners to skip warnings.
     */
    if (scan.items?.some((i) => i.extractedByVision)) {
      notices.push({
        tone: "warn",
        text:
          "FinSight couldn't read this receipt's text. These values were interpreted from the photo by AI, " +
          "so treat them as a first guess rather than something read off the paper — check every one, " +
          "including the total, against the photo.",
      });
    } else if (scan.visionAssisted) {
      notices.push({
        tone: "warn",
        text:
          "Some item names were filled in by AI. The amounts were read from the receipt and match its " +
          "total, but the printing was faint enough that FinSight wasn't sure of the wording — check the " +
          "item names against the photo.",
      });
    }

    return notices;
  })();

  /** Items and completed added lines, grouped by category with a subtotal each. */
  const itemGroups = (() => {
    const groups = new Map<number | null, { total: number; count: number }>();
    const add = (key: number | null, amount: number) => {
      const g = groups.get(key) ?? { total: 0, count: 0 };
      g.total += amount;
      g.count += 1;
      groups.set(key, g);
    };
    for (const item of items) add(itemCategories[item.id] ?? null, item.amount);
    for (const a of usableAddedItems) add(a.categoryId, Number(a.amount));
    return [...groups.entries()];
  })();

  /*
   * The camera takes the WHOLE screen — a Modal, not an early return.
   *
   * An early return was the first attempt and it was wrong on a device. This
   * screen sits inside a navigation stack with a "Scan receipt" header and
   * under a tab bar, and returning a view from here renders it BETWEEN them:
   * the viewfinder lost roughly a fifth of its height to chrome, and the
   * receipt guide inside it came out as a small box floating in the middle.
   * The frame then implied the receipt had to fit in a quarter of the screen,
   * which is the opposite of what it is for — a receipt should fill the
   * picture, because resolution is the one thing OCR cannot get back.
   *
   * A Modal escapes both the header and the tab bar without touching
   * navigation options, so nothing has to be restored afterwards — a
   * `setOptions` approach has to put the tab bar back on every exit path, and
   * the one that gets missed leaves the app with no navigation at all.
   *
   * `statusBarTranslucent` lets the preview run under the status bar; the
   * camera's own SafeAreaView keeps the controls clear of it.
   *
   * `onRequestClose` is the Android back button, and it must be handled here.
   * Without it, back dismisses the modal without telling this screen, and
   * `cameraOpen` stays true — so the camera can never be reopened.
   */
  const camera = (
    <Modal
      visible={cameraOpen}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => setCameraOpen(false)}
    >
      {/*
        Mounted only while visible, so the sensor and the torch are not left
        running behind the review form.
      */}
      {cameraOpen ? (
        <ReceiptCamera
          initialSections={sectionsFromPages(pages)}
          onCancel={() => {
            setCameraOpen(false);
            /*
             * Closing the camera with nothing photographed leaves this screen
             * entirely, rather than revealing the capture card behind it.
             *
             * There is nothing on that card worth stopping at: no sections to
             * review, no scan to check — just the "Open the camera" button the
             * owner already pressed. Backing out of a scan should undo the
             * scan, not park them one tap away from starting it again.
             *
             * Sections already captured are the opposite case and are left
             * alone: those are work, and the card is where they get reviewed,
             * reordered and sent.
             */
            if (pages.length === 0 && navigation.canGoBack()) navigation.goBack();
          }}
          onDone={(sections) => {
            setPages(pagesFromSections(sections));
            setCameraOpen(false);
          }}
        />
      ) : null}
    </Modal>
  );

  return (
    <Screen>
      {camera}
      {/*
        Nothing is rendered behind the camera.

        The screen opens straight into it, so anything here would be a card
        flashing up for the length of the modal's fade and then being covered
        — and on the way back out it would appear for an instant before this
        screen pops. Rendering nothing is also rendering nothing to lay out,
        which keeps the preview's first frame from competing with a form for
        the same window insets.
      */}
      {cameraOpen ? null : (
      /*
        The longest form in the app: a review card, then a row per item, then
        the reconciliation question. Typing into a field near the bottom used
        to put it behind the keyboard with no way to scroll it back into view.
        The ScrollView keeps its own contentContainerStyle and paddingBottom —
        this only wraps it, so scrolling behaves exactly as before when no
        keyboard is up.
      */
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
          {!scan ? (
            <Card>
              <T variant="title" style={{ marginBottom: 4 }}>Scan a receipt</T>
              <T variant="caption" style={{ marginBottom: space.lg }}>
                {pages.length === 0
                  ? "Photograph a receipt and FinSight will read the date, store and amount. You check them before anything is saved."
                  : "Add another section only if this receipt didn't fit in one — otherwise scan what you have."}
              </T>

              {busy ? (
                // The OCR wait is the app's slowest interaction — commit to
                // the shape of the answer instead of a bare spinner, same
                // reasoning as web's ScanReceipt read skeleton.
                <View style={{ gap: space.sm, paddingVertical: space.md }}>
                  <T variant="caption" style={{ marginBottom: space.xs }}>Reading the receipt…</T>
                  <SkeletonBox width="40%" height={14} />
                  <SkeletonBox height={14} />
                  <SkeletonBox width="70%" height={14} />
                  <SkeletonBox width="55%" height={14} />
                </View>
              ) : (
                <>
                  {/*
                    The filmstrip, shown once there is something to show. A
                    single photo never reaches this — pressing "Scan this
                    receipt" fires the instant one page exists, same as the
                    old single-tap flow, so the common case gains no step.
                  */}
                  {pages.length > 0 ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
                      <View style={{ flexDirection: "row", gap: space.sm }}>
                        {pages.map((p, i) => (
                          <View key={p.key} style={{ width: 84 }}>
                            <View
                              style={{
                                width: 84,
                                height: 112,
                                borderRadius: radius.sm,
                                overflow: "hidden",
                                backgroundColor: paper[100],
                                borderWidth: 1,
                                borderColor: ink[200],
                              }}
                            >
                              <Image source={{ uri: p.uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                              <View
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  left: 4,
                                  backgroundColor: "rgba(255,255,255,0.9)",
                                  borderRadius: radius.full,
                                  paddingHorizontal: 6,
                                  paddingVertical: 1,
                                }}
                              >
                                <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: ink[700] }}>{i + 1}</T>
                              </View>
                              <Pressable
                                onPress={() => removePage(p.key)}
                                accessibilityRole="button"
                                accessibilityLabel={`Remove page ${i + 1}`}
                                // The visible chip stays 22px so it doesn't
                                // swallow the thumbnail, but hitSlop brings
                                // the actual tap target up to TAP (44px) —
                                // 8px was 6px short even with hitSlop.
                                hitSlop={11}
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  right: 4,
                                  width: 22,
                                  height: 22,
                                  borderRadius: radius.full,
                                  backgroundColor: "rgba(255,255,255,0.9)",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Ionicons name="close" size={14} color={ink[700]} />
                              </Pressable>
                              {p.checkingQuality ? (
                                <View style={{ position: "absolute", bottom: 4, right: 4 }}>
                                  <ActivityIndicator size="small" color={brand[600]} />
                                </View>
                              ) : null}
                            </View>
                            {/*
                              Caught at capture, not after the whole session
                              uploads — see addPage's own comment for why that
                              order matters.
                            */}
                            {p.quality?.tooBlurredToTrust ? (
                              <T style={{ fontSize: typeScale.axis, color: statusText.warning, marginTop: 2, textAlign: "center" }}>
                                ⚠ blurry
                              </T>
                            ) : null}
                            <View style={{ flexDirection: "row", justifyContent: "center", gap: 2, marginTop: 2 }}>
                              <Pressable
                                onPress={() => movePage(p.key, -1)}
                                disabled={i === 0}
                                accessibilityRole="button"
                                accessibilityLabel={`Move page ${i + 1} earlier`}
                                hitSlop={8}
                                style={{ padding: 4, opacity: i === 0 ? 0.3 : 1 }}
                              >
                                <Ionicons name="chevron-up" size={16} color={ink[600]} />
                              </Pressable>
                              <Pressable
                                onPress={() => movePage(p.key, 1)}
                                disabled={i === pages.length - 1}
                                accessibilityRole="button"
                                accessibilityLabel={`Move page ${i + 1} later`}
                                hitSlop={8}
                                style={{ padding: 4, opacity: i === pages.length - 1 ? 0.3 : 1 }}
                              >
                                <Ionicons name="chevron-down" size={16} color={ink[600]} />
                              </Pressable>
                            </View>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  ) : null}

                  <View style={{ gap: space.sm }}>
                    {pages.length === 0 ? (
                      <>
                        <Button title="Open the camera" variant="primary" onPress={capturePage} />
                        <Button title="Choose from gallery" variant="secondary" onPress={pickPage} />
                      </>
                    ) : (
                      <>
                        <Button
                          title={
                            pages.length === 1 ? "Scan this receipt" : `Scan these ${pages.length} sections`
                          }
                          variant="primary"
                          onPress={() => void scanPages()}
                        />
                        {/*
                          Reopens the camera on the session already captured,
                          rather than starting an empty one — see
                          sectionsFromPages. Hidden at the ceiling because the
                          server refuses a ninth page, and a button that can
                          only produce a 400 is worse than no button.
                        */}
                        {canAddSection(pages.length) ? (
                          <Button title="Add another section" variant="secondary" onPress={capturePage} />
                        ) : null}
                      </>
                    )}
                  </View>
                </>
              )}
              {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
            </Card>
          ) : (
            <>
              {/*
                THE PHOTOGRAPH FIRST.

                Nearly every sentence on this screen ends in "against the
                photo" — check the amounts against it, check the item names
                against it, check whether it holds two receipts. The photo was
                the one thing the screen never showed. These are the local
                files the capture session produced, so they cost nothing to
                display and are already the exact images that were read.
              */}
              {pages.length > 0 ? (
                <Card>
                  <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
                  <T variant="caption" style={{ marginBottom: space.md }}>
                    {pages.length === 1
                      ? "Compare what FinSight read against the photo. Nothing is saved until you confirm."
                      : `Compare what FinSight read against the ${pages.length} sections. Nothing is saved until you confirm.`}
                  </T>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: "row", gap: space.sm }}>
                      {pages.map((p, i) => (
                        <View
                          key={p.key}
                          style={{
                            width: 96,
                            height: 128,
                            borderRadius: radius.sm,
                            overflow: "hidden",
                            backgroundColor: paper[100],
                            borderWidth: 1,
                            borderColor: ink[200],
                          }}
                        >
                          <Image
                            source={{ uri: p.uri }}
                            style={{ width: "100%", height: "100%" }}
                            resizeMode="cover"
                            accessibilityRole="image"
                            accessibilityLabel={
                              pages.length === 1 ? "The receipt you photographed" : `Section ${i + 1} of ${pages.length}`
                            }
                            accessibilityIgnoresInvertColors
                          />
                          {pages.length > 1 ? (
                            <View
                              style={{
                                position: "absolute",
                                top: 4,
                                left: 4,
                                backgroundColor: "rgba(255,255,255,0.9)",
                                borderRadius: radius.full,
                                paddingHorizontal: 6,
                                paddingVertical: 1,
                              }}
                            >
                              <T style={{ fontSize: typeScale.micro, fontFamily: font.monoMedium, color: ink[700] }}>{i + 1}</T>
                            </View>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </Card>
              ) : (
                <Card>
                  <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
                  <T variant="caption">
                    FinSight filled these in from the photo. Correct anything that's wrong — nothing is
                    saved until you confirm.
                  </T>
                </Card>
              )}

              {/*
                The band goes ABOVE the warnings: it is the one-line answer to
                "how much of this should I doubt", and the warnings are the
                detail behind it. The other way round buries the summary under
                its own footnotes.
              */}
              <ScanBand band={scanBand} fields={attentionFields} />

              <ReviewNotices notices={reviewNotices} />

              <ReviewSection
                title={isItemised ? "Receipt totals" : "This expense"}
                caption={
                  isItemised
                    ? "The date, store and total for the whole receipt. Each line gets its own category below."
                    : undefined
                }
              >
              {!isItemised ? (
                <CategoryPicker
                  categories={categories}
                  value={categoryId}
                  onChange={setCategoryId}
                  onCreated={refreshCategories}
                />
              ) : null}
              <DateField label="Date" value={date} onChange={setDate} />
              {/*
                Where the value above came from. Shown under the field it
                describes rather than in a panel of its own — the question
                "where did this date come from" is only ever asked while
                looking at the date.
              */}
              <EvidenceNote evidence={scan.fieldEvidence?.date} />
              <Field
                label="Description"
                value={description}
                maxLength={FIELD_LIMITS.recordDescription}
                onChangeText={setDescription}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => vendorRef.current?.focus()}
              />
              <Field
                ref={vendorRef}
                label="Vendor"
                value={vendor}
                maxLength={FIELD_LIMITS.vendor}
                onChangeText={setVendor}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => amountRef.current?.focus()}
              />
              <EvidenceNote evidence={scan.fieldEvidence?.vendor} />
              {/*
                "done" closes the keyboard rather than confirming. Amount is the
                last thing to TYPE but not the last thing to decide — an itemised
                receipt still has a category per line and possibly a difference to
                account for below. A return key that saved here would skip past
                the review this screen exists for.
              */}
              <Field
                ref={amountRef}
                label="Amount (PHP)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />
              <EvidenceNote evidence={scan.fieldEvidence?.amount} />
              </ReviewSection>

              {isItemised ? (
                <ReviewSection
                  title={`Items (${items.length})`}
                  caption={`FinSight ${items.some((i) => i.extractedByVision) ? "found" : "read"} ${items.length} items. Put each one in a category — check them against the photo and change any that are wrong.`}
                >

                  {items.map((item) => (
                    <View
                      key={item.id}
                      /*
                        A rule ABOVE each row and generous padding, rather than
                        a box per item. A receipt can carry a dozen lines and
                        boxing each one turns the list into a stack of cards
                        inside a card; a rule separates them at a fraction of
                        the visual weight.
                      */
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: paper[200],
                        paddingTop: space.md,
                        paddingBottom: space.md,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                        <T style={{ flex: 1, fontSize: typeScale.bodySm, color: ink[900], lineHeight: 20 }} numberOfLines={2}>
                          {item.name}
                          {item.quantity != null ? (
                            <T variant="caption"> × {item.quantity}</T>
                          ) : null}
                        </T>
                        {/*
                          `decimals` is not cosmetic here. Without it
                          toLocaleString ROUNDS to whole pesos, so a 123.50
                          line printed as "PHP 124" — a figure that appears
                          nowhere on the receipt — and a column of them stopped
                          adding up to the total shown above. Whole pesos are
                          right for a summary; they are wrong for a line the
                          owner is checking against paper. Web's own scan
                          review passes it on every amount for this reason.
                        */}
                        <Money value={item.amount} size={14} weight="semibold" decimals />
                        {/* Removing a line OCR should never have read. */}
                        <Pressable
                          onPress={() => removeScannedItem(item.id)}
                          disabled={removingItemId === item.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove ${item.name} — this was not a purchase`}
                          // 24px visible, but the actual tap target needs to
                          // clear TAP (44px) — 6px of hitSlop left it 8px
                          // short.
                          hitSlop={10}
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: radius.full,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: paper[100],
                            opacity: removingItemId === item.id ? 0.4 : 1,
                          }}
                        >
                          {/*
                            An icon rather than a "×" glyph: the glyph rendered
                            at whatever weight the system font gave it, which
                            beside a bold amount read as punctuation rather
                            than as a control.
                          */}
                          <Ionicons name="close" size={13} color={ink[500]} />
                        </Pressable>
                      </View>

                      {/*
                        A line a model inferred from a photograph must not look
                        like one read off text. Marked per row, because the row
                        is where the owner actually decides.
                      */}
                      {item.extractedByVision ? (
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          ✦ AI read this from the photo
                        </T>
                      ) : null}

                      {/*
                        The server names the line it is least sure of when the
                        items do not add up. Pointing at one row beats asking the
                        owner to re-read all nine.
                      */}
                      {scan.suspectItemId === item.id ? (
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          ⚠ Check this one first — the items don't add up to the total
                        </T>
                      ) : needsAttention({
                          confidence: item.amountConfidence,
                          visionAssisted: item.extractedByVision,
                        }) && typeof item.amountConfidence === "number" ? (
                        /*
                          The BAND, not "FinSight was 62% sure of this amount".
                          A percentage against one line invited the owner to
                          grade it, and it used its own 75 cutoff — a third
                          opinion about the same number. Same mapping as the
                          heading now (lib/confidenceBands.ts).
                        */
                        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
                          {BAND_COPY[confidenceBand({
                            confidence: item.amountConfidence,
                            visionAssisted: item.extractedByVision,
                          })].label} — check this amount against the receipt
                        </T>
                      ) : null}
                      {/* Which printed line this came from, where the server
                          could locate it. Never invented. */}
                      {evidenceSummary(item.evidence) ? (
                        <T variant="caption" style={{ marginTop: 2 }}>{evidenceSummary(item.evidence)}</T>
                      ) : null}

                      <View style={{ marginTop: space.sm }}>
                        <CategoryChips
                          categories={categories}
                          value={itemCategories[item.id] ?? null}
                          // No haptic here: the chip fires its own, and firing a
                          // second would buzz twice for one tap.
                          onChange={(id) => setItemCategories((prev) => ({ ...prev, [item.id]: id }))}
                          label={item.name}
                        />
                      </View>

                      {/*
                        A category FinSight thinks is missing.

                        Phrased as an offer rather than an assignment, because
                        nothing is created until the owner says so — inventing
                        categories in someone's books is not FinSight's call.
                      */}
                      {suggestedNewCategoryFor(item) ? (
                        <Pressable
                          onPress={() => acceptSuggestedCategory(item.suggestedCategoryName!)}
                          disabled={creatingCategoryFor !== null}
                          accessibilityRole="button"
                          accessibilityLabel={`Create the category ${item.suggestedCategoryName} and file ${item.name} under it`}
                          style={{ marginTop: space.sm, opacity: creatingCategoryFor !== null ? 0.5 : 1 }}
                        >
                          <T variant="caption" style={{ color: brand[700] }}>
                            {creatingCategoryFor === item.suggestedCategoryName
                              ? "Creating…"
                              : `✦ Nothing fits this. Create "${item.suggestedCategoryName}"?`}
                          </T>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}

                  {/*
                    Lines the owner is adding because OCR missed them.

                    Kept visually distinct from the extracted rows: the text
                    above claims FinSight READ these items, and that claim must
                    not quietly extend to a row a human typed. The same
                    distinction is stored server-side (addedByOwner) so it
                    survives onto the saved record.
                  */}
                  {addedItems.map((added, i) => (
                    <View
                      key={added.key}
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: paper[100],
                        backgroundColor: paper[50],
                        paddingVertical: space.sm,
                        paddingHorizontal: space.sm,
                      }}
                    >
                      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                        <T variant="caption">You're adding this line</T>
                        <Pressable
                          onPress={() => setAddedItems((prev) => prev.filter((x) => x.key !== added.key))}
                          accessibilityRole="button"
                          accessibilityLabel={`Remove added item ${i + 1}`}
                          style={{ minWidth: TAP - 12, minHeight: TAP - 16, alignItems: "flex-end" }}
                        >
                          <T style={{ fontSize: typeScale.bodyLg, color: ink[400] }}>×</T>
                        </Pressable>
                      </View>
                      <Field
                        label="Item name"
                        value={added.name}
                        onChangeText={(v: string) =>
                          setAddedItems((prev) => prev.map((x) => (x.key === added.key ? { ...x, name: v } : x)))
                        }
                        returnKeyType="next"
                        submitBehavior="submit"
                        onSubmitEditing={() => addedAmountRefs.current[added.key]?.focus()}
                      />
                      <Field
                        ref={(el) => {
                          if (el) addedAmountRefs.current[added.key] = el;
                          else delete addedAmountRefs.current[added.key];
                        }}
                        label="Amount (PHP)"
                        value={added.amount}
                        keyboardType="decimal-pad"
                        // The row ends at its category chips, which are pressables
                        // and cannot be focused from a keyboard — so this closes
                        // the keyboard and leaves the chips visible underneath.
                        returnKeyType="done"
                        onChangeText={(v: string) =>
                          setAddedItems((prev) => prev.map((x) => (x.key === added.key ? { ...x, amount: v } : x)))
                        }
                      />
                      <CategoryChips
                        categories={categories}
                        value={added.categoryId}
                        onChange={(id) =>
                          setAddedItems((prev) =>
                            prev.map((x) => (x.key === added.key ? { ...x, categoryId: id } : x)),
                          )
                        }
                        label={added.name || `added item ${i + 1}`}
                      />
                    </View>
                  ))}

                  <Pressable
                    onPress={() =>
                      setAddedItems((prev) => [
                        ...prev,
                        { key: `added-${Date.now()}-${prev.length}`, name: "", amount: "", categoryId: null },
                      ])
                    }
                    accessibilityRole="button"
                    style={{ paddingVertical: space.sm }}
                  >
                    <T variant="caption" style={{ color: brand[700] }}>
                      + An item is missing — add it to the list
                    </T>
                  </Pressable>
                </ReviewSection>
              ) : null}

              {/*
                WHAT ACTUALLY GETS SAVED — one record per category group.

                Its own section, and the last one before the button. It used to
                be a tinted panel at the bottom of the item list, which put the
                answer to "what am I about to agree to" inside the list of
                things being agreed to. It is the only part of this screen that
                describes the OUTCOME rather than the reading.
              */}
              {isItemised ? (
                <Card emphasis>
                  <View>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: space.sm,
                        marginBottom: space.sm,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <T variant="heading" accessibilityRole="header" style={{ color: brand[900] }}>
                          What gets saved
                        </T>
                        {/* The band, not the percentage — the number is at the
                            top of the screen in words already, and repeating
                            it here as "87%" would put the two cues back into
                            competition. */}
                        <T variant="caption">{BAND_COPY[scanBand].label}</T>
                      </View>
                      {/*
                        Whether the receipt balances, stated as a badge rather
                        than left for the owner to work out by comparing two
                        numbers in different places. Colour is never the only
                        signal — the badge carries a glyph and words.
                      */}
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                          paddingHorizontal: space.sm,
                          paddingVertical: 3,
                          borderRadius: radius.full,
                          backgroundColor: gap === 0 ? "#eafaf1" : "#fffbeb",
                        }}
                      >
                        <T
                          style={{
                            fontSize: typeScale.micro,
                            color: gap === 0 ? statusText.good : statusText.warning,
                          }}
                        >
                          {gap === 0
                            ? "✓ Balances"
                            : `⚠ ${gap > 0 ? "Short" : "Over"} PHP ${(Math.abs(gap) / 100).toFixed(2)}`}
                        </T>
                      </View>
                    </View>
                    {itemGroups.map(([catId, g]) => (
                      <View
                        key={String(catId)}
                        style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm, marginTop: 2 }}
                      >
                        <T style={{ flex: 1, fontSize: typeScale.label, color: catId == null ? statusText.warning : ink[700] }}>
                          {catId == null
                            ? "Not categorised yet"
                            : (categories.find((c) => c.id === catId)?.name ?? "Category")}
                          <T variant="caption"> ({g.count} item{g.count === 1 ? "" : "s"})</T>
                        </T>
                        <Money value={g.total} size={13} decimals />
                      </View>
                    ))}
                    <T
                      variant="caption"
                      style={{ marginTop: space.sm, color: everyItemHasCategory && planResolved ? statusText.good : statusText.warning }}
                    >
                      {!everyItemHasCategory
                        ? "⚠ Every item needs a category before this can be saved."
                        : gap === 0
                          ? `✓ ${itemGroups.length} record${itemGroups.length === 1 ? "" : "s"} will be saved, adding up to the receipt total.`
                          : plan === "shrink"
                            ? `✓ The receipt will be saved as PHP ${itemsTotal.toFixed(2)} — the items' own total.`
                            : planResolved
                              ? "✓ Ready to save."
                              : gap > 0
                                ? `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(gap / 100).toFixed(2)} less than the total above.`
                                : `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(-gap / 100).toFixed(2)} more than the total above.`}
                    </T>
                  </View>

                  {/*
                    Accounting for the difference.

                    A gap is normal rather than a mistake: a VAT-exclusive
                    register adds tax on top of the printed lines, a discount
                    takes money off, and OCR sometimes just misses a line. So the
                    screen asks what the difference IS instead of blocking until
                    the arithmetic works — which, on a VAT-exclusive receipt, it
                    never would. The total never changes on its own; only the
                    last option touches it, and only to figures read off the
                    receipt.
                  */}
                  {everyItemHasCategory && gap !== 0 ? (
                    <View style={{ marginTop: space.md }}>
                      <T variant="label" style={{ color: ink[700], marginBottom: 4 }}>
                        {gap > 0
                          ? `What is the missing PHP ${(gap / 100).toFixed(2)}?`
                          : `What is the extra PHP ${(-gap / 100).toFixed(2)}?`}
                      </T>
                      <T variant="caption" style={{ marginBottom: space.sm }}>
                        {gap > 0
                          ? "Receipts often add tax or a service charge on top of the item prices, and sometimes a line just doesn't scan."
                          : "A discount or a voided line usually explains this."}
                      </T>

                      <GapOption
                        selected={plan === "proportional"}
                        onPress={() => {
                          haptics.tapped();
                          setPlan("proportional");
                        }}
                        title={gap > 0 ? "Tax or a service charge" : "A discount on the whole receipt"}
                        detail="Split across the categories above, in proportion to what each came to. Keeps every category's spending accurate."
                      />
                      {canFileGapOnItsOwn ? (
                        <GapOption
                          selected={plan === "category"}
                          onPress={() => {
                            haptics.tapped();
                            setPlan("category");
                          }}
                          title="A separate charge to track on its own"
                          detail="Saved as its own expense record under one category."
                        >
                          {plan === "category" ? (
                            <View style={{ marginTop: space.sm }}>
                              <CategoryChips
                                categories={categories}
                                value={gapCategoryId}
                                onChange={setGapCategoryId}
                                label="the remaining amount"
                              />
                            </View>
                          ) : null}
                        </GapOption>
                      ) : null}
                      <GapOption
                        selected={plan === "shrink"}
                        onPress={() => {
                          haptics.tapped();
                          setPlan("shrink");
                        }}
                        title="FinSight misread the receipt total"
                        detail={`Save PHP ${itemsTotal.toFixed(2)} — the items' own total — instead of the amount above.`}
                      />
                    </View>
                  ) : null}
                </Card>
              ) : null}

              {/*
                The actions sit outside the sections rather than at the end of
                the last one. They apply to the whole review, and putting them
                inside "Items" made them look like part of the item list — on
                a long receipt they arrived after nine category pickers with
                nothing to say they had left that subject.
              */}
              <View>
                {error ? <View style={{ marginBottom: space.sm }}><ErrorNote>{error}</ErrorNote></View> : null}
                <Button
                  title={
                    isItemised && itemGroups.length > 1
                      ? `Save ${itemGroups.length} expenses`
                      : "Save this expense"
                  }
                  variant="primary"
                  onPress={confirm}
                  loading={busy}
                />
                <Button
                  title="Retake photo"
                  variant="ghost"
                  onPress={() => {
                    setScan(null);
                    // Rescan is a deliberate "start over" — the captured pages
                    // belonged to the receipt just reviewed, and carrying them
                    // into a new session would mean the next scan quietly
                    // starts with photos of the WRONG receipt already loaded.
                    setPages([]);
                  }}
                />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      )}
    </Screen>
  );
}
