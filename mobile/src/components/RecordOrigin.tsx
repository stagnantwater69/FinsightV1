import { useState } from "react";
import { Image, Linking, Pressable, View } from "react-native";
import { Callout, Money, T } from "./ui";
import { brand, font, ink, paper, radius, space, statusText, typeScale } from "../theme/tokens";

/**
 * Where a saved record came from.
 *
 * A record created from a receipt has evidence behind it — the lines that
 * were read, what they came to, and the other records the same scan produced.
 * Mobile showed none of that, so an expense the owner did not recognise was a
 * dead end: nothing on screen explained what made up the number.
 *
 * Mirrors web's RecordOriginPanel. The receipt photograph and the imported
 * file are both here now — the server has always returned signed links for
 * them, and the phone that took the picture is the last place that should be
 * unable to show it back.
 */

export interface OriginItem {
  id: number;
  lineNumber: number;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  categoryName: string | null;
  addedByOwner: boolean;
  extractedByVision?: boolean;
}

export type RecordOrigin =
  | {
      kind: "receipt_scan";
      scanId: number;
      scannedAt: string;
      extractedVendor: string | null;
      /** A short-lived signed link. Null when it couldn't be minted. */
      imageUrl: string | null;
      items: OriginItem[];
      itemsSubtotal: number;
      siblings: { id: number; description: string; amount: number; categoryName: string }[];
    }
  | {
      kind: "csv_import";
      batchId: number;
      title: string;
      uploadDate: string;
      fileReference: string;
      /** A short-lived signed download link. Null when it couldn't be minted. */
      fileUrl: string | null;
      status: string;
      rowCount: number;
    };

export function RecordOriginPanel({ origin, recordAmount }: { origin: RecordOrigin; recordAmount: number }) {
  if (origin.kind === "csv_import") {
    return (
      <View style={{ padding: space.md, backgroundColor: paper[100], borderRadius: radius.md }}>
        <T variant="label" style={{ color: ink[700] }}>Imported from a file</T>
        <T variant="caption" style={{ marginTop: 2 }}>
          {origin.title} · {origin.rowCount} row{origin.rowCount === 1 ? "" : "s"} ·{" "}
          {origin.uploadDate.slice(0, 10)}
        </T>
        {/*
          A spreadsheet is not something to render on a phone — the useful
          thing is handing it to whatever app the owner already opens files
          with, which is what Linking does. Shown only when the link exists:
          sourceCleanup removes the file once the last record from it is gone,
          and a dead link that opens an XML error page is worse than no link.
        */}
        {origin.fileUrl ? (
          <Pressable
            onPress={() => Linking.openURL(origin.fileUrl!)}
            hitSlop={12}
            accessibilityRole="link"
            accessibilityLabel="Open the file this record was imported from"
            style={{ marginTop: space.sm }}
          >
            <T variant="caption" style={{ color: brand[700], fontFamily: font.sansSemibold }}>
              Open the file this came from
            </T>
          </Pressable>
        ) : null}
      </View>
    );
  }

  /*
   * Whether the breakdown still explains the record's own amount.
   *
   * They legitimately differ — receipt-level tax or a discount is allocated
   * across categories, and the owner may have corrected a figure OCR got
   * wrong. Saying so is better than showing two numbers that disagree and
   * leaving the owner to wonder which is broken. Centavos, because floating
   * point would otherwise invent a mismatch.
   */
  const groupTotal = origin.items.reduce((sum, i) => sum + Math.round(i.amount * 100), 0);
  const drifted = origin.items.length > 0 && groupTotal !== Math.round(recordAmount * 100);

  return (
    <View style={{ padding: space.md, backgroundColor: paper[100], borderRadius: radius.md }}>
      <T variant="label" style={{ color: ink[700] }}>Read from a receipt</T>
      <T variant="caption" style={{ marginTop: 2, marginBottom: space.sm }}>
        {origin.extractedVendor ? `${origin.extractedVendor} · ` : ""}
        scanned {origin.scannedAt.slice(0, 10)}
      </T>

      {origin.items.length === 0 ? (
        <T variant="caption">
          FinSight couldn't read individual items off this receipt — only the total.
        </T>
      ) : (
        origin.items.map((item) => (
          <View
            key={item.id}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: space.sm,
              paddingVertical: 3,
            }}
          >
            <View style={{ flex: 1 }}>
              <T style={{ fontSize: typeScale.label, color: ink[800] }} numberOfLines={2}>
                {item.name}
                {item.quantity != null ? <T variant="caption"> × {item.quantity}</T> : null}
              </T>
              {/*
                The heading says these were READ from a receipt. A line the
                owner typed, or one a model inferred from a photograph, was
                not — and must say so rather than shelter under that claim.
              */}
              {item.addedByOwner ? (
                <T variant="caption" style={{ color: ink[500] }}>you added this</T>
              ) : item.extractedByVision ? (
                <T variant="caption" style={{ color: statusText.warning }}>✦ AI read this from the photo</T>
              ) : null}
            </View>
            <Money value={item.amount} size={13} />
          </View>
        ))
      )}

      {origin.items.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            borderTopWidth: 1,
            borderTopColor: ink[200],
            marginTop: space.sm,
            paddingTop: space.sm,
          }}
        >
          <T variant="caption">These items come to</T>
          <Money value={origin.itemsSubtotal} size={13} weight="semibold" />
        </View>
      ) : null}

      {drifted ? (
        <View style={{ marginTop: space.sm }}>
          <Callout tone="info">
            This record's amount doesn't match the items above. That is normal when receipt-level tax or a
            discount was shared out, or if the amount was corrected by hand.
          </Callout>
        </View>
      ) : null}

      {origin.siblings.length > 0 ? (
        <View style={{ marginTop: space.sm }}>
          <T variant="caption" style={{ marginBottom: 2 }}>
            The same receipt also saved:
          </T>
          {origin.siblings.map((s) => (
            <View
              key={s.id}
              style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm, paddingVertical: 2 }}
            >
              <T style={{ flex: 1, fontSize: typeScale.label, color: ink[700] }} numberOfLines={1}>
                {s.categoryName}
              </T>
              <Money value={s.amount} size={13} />
            </View>
          ))}
        </View>
      ) : null}

      {origin.imageUrl ? <ReceiptPhoto url={origin.imageUrl} /> : null}
    </View>
  );
}

/**
 * The receipt itself, behind a tap.
 *
 * Mobile has had the breakdown but never the photograph, so an owner who
 * doubted a figure had nothing to check it against — on the one device that
 * took the picture.
 *
 * Collapsed by default because the usual reason to open a record is to change
 * a field, and a phone screen spent on a picture nobody asked for is a screen
 * of scrolling before the form. Given a fixed height with `contain` rather
 * than a free-running aspect ratio, for the reason the web panel learned the
 * hard way: a till receipt is tall and narrow, so sizing it by width alone
 * produces something thousands of pixels long.
 */
function ReceiptPhoto({ url }: { url: string }) {
  const [open, setOpen] = useState(false);

  return (
    <View style={{ marginTop: space.sm }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? "Hide the receipt photo" : "Show the receipt photo"}
      >
        <T variant="caption" style={{ color: brand[700], fontFamily: font.sansSemibold }}>
          {open ? "Hide the receipt photo" : "Show the receipt photo"}
        </T>
      </Pressable>
      {open ? (
        <Image
          source={{ uri: url }}
          resizeMode="contain"
          accessibilityLabel="The scanned receipt this record came from"
          style={{
            width: "100%",
            height: 320,
            marginTop: space.sm,
            borderRadius: radius.sm,
            backgroundColor: paper[200],
          }}
        />
      ) : null}
    </View>
  );
}
