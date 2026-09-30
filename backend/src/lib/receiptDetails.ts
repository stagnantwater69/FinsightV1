/** Optional details printed on a receipt. These never change booked amounts. */
export interface ReceiptDetails {
  currency: string | null;
  transactionTime: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  discount: number | null;
  paymentMethod: string | null;
  receiptNumber: string | null;
}

const CURRENCY_CODES = "PHP|USD|EUR|GBP|JPY|CNY|AUD|CAD|NZD|SGD|HKD|MYR|THB|IDR|INR|AED|KRW|VND|CHF|TWD";

/**
 * Pesos as Philippine registers print them: a bare "P" or "₱" on an amount.
 * OCR puts a space before the decimal point as often as not ("P7967 .25").
 */
const PESO_AMOUNT = /(?:₱|\bP)[ \t]*\d[\d,]*[ \t]*[.,][ \t]*\d{2}\b/;

/** The line stating what was paid. A mark on it is the receipt's own currency. */
const TOTAL_LINE = /\b(?:total|amount\s+due|balance)\b/i;
const SUBTOTAL_LINE = /\bsub\s*-?\s*total\b/i;

/**
 * Currency marks OCR also makes out of noise, each with the code it names
 * (null where the symbol names no one currency).
 *
 * Measured on a real Gaisano receipt with a red pen stroke through its
 * quantity column: tesseract read the stroke as "¥" ("¥ 1 80.00 80.007") and
 * an 8 as "£" ("£0.00" for 80.00). A lone "¥" before any digit was enough to
 * send that peso receipt to manual entry. So a yen figure must end its run of
 * numbers (a quantity followed by prices is not a yen amount), and every mark
 * here needs corroboration — see `corroboratedMarks`.
 *
 * Horizontal space only, any amount of it: a receipt column right-aligns its
 * figures, so "$      12.50" is one printed amount, while `\s` would let a
 * symbol on one line pair with a number on the next and invent a currency.
 */
const NOISE_PRONE_MARKS: { pattern: RegExp; code: string | null }[] = [
  { pattern: /€[ \t]*\d[\d,]*[.,]\d{2}\b/, code: "EUR" },
  { pattern: /£[ \t]*\d[\d,]*[.,]\d{2}\b/, code: "GBP" },
  { pattern: /\bA\$[ \t]*\d/, code: "AUD" },
  { pattern: /\bC\$[ \t]*\d/, code: "CAD" },
  { pattern: /\bS\$[ \t]*\d/, code: "SGD" },
  // A dollar sign on an amount with centavos. OCR reads "#" and "S" as "$";
  // a bare "$" before any digit made "Serial #6600441" a dollar amount.
  { pattern: /(?<![A-Za-z])\$[ \t]*\d[\d,]*[.,][ \t]*\d{2}\b/, code: null },
  // Yen and yuan amounts carry no decimals, so any figure — but the last one
  // in its run: "¥ 1 80.00" is a speck before a quantity, not ¥1.
  { pattern: /[¥￥][ \t]*\d[\d,]*(?:[.,]\d+)?(?![ \t]*[\d.,])/, code: null },
];

/**
 * The noise-prone marks the receipt corroborates.
 *
 * A mark counts when it is on the line stating the total, when it is printed
 * on at least two lines, or when nothing on the receipt says pesos. A single
 * foreign mark on one item line of a receipt whose own amounts are printed in
 * pesos is OCR noise, and must not stop the owner saving a peso receipt. A
 * genuinely foreign receipt marks its total, or its amounts throughout.
 */
function corroboratedMarks(text: string, pesoPrinted: boolean): (string | null)[] {
  const lines = text.split(/\r?\n/);
  const marks: (string | null)[] = [];
  for (const { pattern, code } of NOISE_PRONE_MARKS) {
    const hits = lines.filter((line) => pattern.test(line));
    if (hits.length === 0) continue;
    const onTotal = hits.some((line) => TOTAL_LINE.test(line) && !SUBTOTAL_LINE.test(line));
    if (!pesoPrinted || onTotal || hits.length >= 2) marks.push(code);
  }
  return marks;
}

/** Currency codes printed as words, or with a two-letter dollar prefix: never produced by noise. */
function explicitCurrencies(text: string): Set<string> {
  const found = new Set<string>();
  // A code counts beside a figure on the SAME line, or after a "Currency"
  // label. Allowing a newline between them let any OCR fragment that ended a
  // line in three capitals ("... CAD", "... INR") pair with the product code
  // opening the next row, which on a long itemised receipt is every row.
  for (const match of text.matchAll(new RegExp(`\\bcurrency[ \\t]*[:=]?[ \\t]*(${CURRENCY_CODES})\\b`, "gi"))) {
    found.add(match[1]!.toUpperCase());
  }
  for (const match of text.matchAll(new RegExp(`\\b(${CURRENCY_CODES})\\b(?=[ \\t]*[:=]?[ \\t]*[-+]?\\d)`, "gi"))) {
    found.add(match[1]!.toUpperCase());
  }
  for (const match of text.matchAll(new RegExp(`\\d[ \\t]*(${CURRENCY_CODES})\\b`, "gi"))) found.add(match[1]!.toUpperCase());
  const prefixedDollars: [RegExp, string][] = [
    [/\bUS\$[ \t]*\d/, "USD"],
    [/\bAU\$[ \t]*\d/, "AUD"],
    [/\bCA\$[ \t]*\d/, "CAD"],
    [/\bNZ\$[ \t]*\d/, "NZD"],
    [/\bSG\$[ \t]*\d/, "SGD"],
    [/\bHK\$[ \t]*\d/, "HKD"],
  ];
  for (const [pattern, code] of prefixedDollars) if (pattern.test(text)) found.add(code);
  return found;
}

interface CurrencyEvidence {
  /** Every currency the receipt names. */
  codes: Set<string>;
  /** A dollar or yen/yuan amount the receipt corroborates, which names no one currency. */
  unidentified: boolean;
}

function currencyEvidence(text: string): CurrencyEvidence {
  const codes = explicitCurrencies(text);
  // Philippine registers print pesos as a bare "P" before the amount.
  if (PESO_AMOUNT.test(text)) codes.add("PHP");
  let unidentified = false;
  for (const mark of corroboratedMarks(text, codes.has("PHP"))) {
    if (mark === null) unidentified = true;
    else codes.add(mark);
  }
  return { codes, unidentified };
}

/**
 * The currency a rescue provider reported, read back off ReceiptScan.extractorVersions.
 * It never reaches the extracted fields, because unvalidated provider evidence
 * cannot displace the printed local reading, but it still has to block a peso booking.
 */
export function providerReportedCurrency(extractorVersions: unknown): string | null {
  if (typeof extractorVersions !== "object" || extractorVersions === null) return null;
  const code = (extractorVersions as Record<string, unknown>).providerCurrency;
  return typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : null;
}

export function requiresManualCurrencyConversion(
  rawText: string | null | undefined,
  providerCurrency: string | null = null,
): boolean {
  const text = rawText ?? "";
  if (providerCurrency !== null && providerCurrency !== "PHP") return true;
  // Dollar and yen/yuan symbols do not identify one exact currency, but they
  // still must not be booked as PHP. Keep the displayed currency unknown and
  // require the owner to enter the actual PHP amount paid.
  const evidence = currencyEvidence(text);
  return evidence.unidentified || [...evidence.codes].some((currency) => currency !== "PHP");
}

function printedAmount(lines: string[], label: RegExp, allowNegative = false): number | null {
  const values = new Set<number>();
  for (const line of lines) {
    if (!label.test(line) || /\b(?:suggested|suggestion|recommended|example|optional|tip\s+guide)\b/i.test(line)) continue;
    const amount = line.match(/(?<![\d.,])([-+]?(?:\d{1,3}(?:[,.]\d{3})+|\d+)[.,]\d{2})\s*(?:[A-Z]{3}|[₱$€£])?\s*$/i)?.[1];
    if (!amount) continue;
    const decimalAt = Math.max(amount.lastIndexOf("."), amount.lastIndexOf(","));
    if (amount.slice(0, decimalAt).includes(amount[decimalAt]!)) continue;
    const value = Number(`${amount.slice(0, decimalAt).replace(/[,.]/g, "")}.${amount.slice(decimalAt + 1)}`);
    if (!Number.isFinite(value) || (!allowNegative && value < 0) || Math.abs(value) >= 10_000_000_000) continue;
    values.add(allowNegative ? Math.abs(value) : value);
  }
  return values.size === 1 ? [...values][0]! : null;
}

function printedTime(lines: string[]): string | null {
  const times = new Set<string>();
  for (const line of lines) {
    if (/\b(?:open|close|hours|valid|expire)\b/i.test(line)) continue;
    if (!/\b(?:time|date|transaction)\b/i.test(line) && !/^\s*\d{1,2}:\d{2}\b/.test(line) && !/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(line)) continue;
    for (const match of line.matchAll(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/gi)) {
      let hour = Number(match[1]);
      if (Number(match[2]) > 59 || Number(match[3] ?? "0") > 59) continue;
      if (match[4]) {
        if (hour < 1 || hour > 12) continue;
        hour = (hour % 12) + (match[4].toUpperCase() === "PM" ? 12 : 0);
      } else if (hour > 23) continue;
      times.add(`${String(hour).padStart(2, "0")}:${match[2]}${match[3] ? `:${match[3]}` : ""}`);
    }
  }
  return times.size === 1 ? [...times][0]! : null;
}

function printedPayment(lines: string[]): string | null {
  const found = new Set<string>();
  for (const line of lines) {
    if (/\b(?:accepted|accepts|welcome|change|cashier|discount|savings|price|refund|balance|advance|withdrawal)\b/i.test(line)) continue;
    const method = line.match(/^\s*(?:(?:payment(?:\s+method)?|paid(?:\s+by)?|tender(?:\s+type)?)\s*[:=-]?\s*)?(cash|credit\s+card|debit\s+card|card|visa|mastercard|amex|gcash|maya|bank\s+transfer)\b/i)?.[1];
    if (method) found.add(method.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()));
  }
  // Return only a method label, never card/account digits printed next to it.
  return found.size === 1 ? [...found][0]! : null;
}

export function parseReceiptDetails(rawText: string | null | undefined): ReceiptDetails {
  const text = rawText ?? "";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const currencies = currencyEvidence(text).codes;
  const receiptNumbers = new Set(lines.flatMap((line) => {
    const match = line.match(/^(?:(?:official|sales|tax)\s+)?(?:receipt|invoice|si|or)\s*(?:no\.?|number|#)\s*[:#-]?\s*([a-z0-9][a-z0-9./-]{0,79})\s*$/i);
    return match ? [match[1]!] : [];
  }));
  return {
    // A bare $ or ¥ is ambiguous; multiple explicit currencies are too.
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    transactionTime: printedTime(lines),
    subtotal: printedAmount(lines, /^sub\s*[- ]?total\b\s*(?=[:=\d₱$€£-]|PHP\b|USD\b|EUR\b|GBP\b)/i),
    tax: printedAmount(lines, /^(?:(?:total|included)\s+)?(?:tax|vat|gst|sales\s+tax)(?:\s+(?:amount|total))?\s*(?=[:=(\d₱$€£-]|PHP\b|USD\b|EUR\b|GBP\b)/i),
    tip: printedAmount(lines.filter((line, index) => !/%/.test(line)
      && !lines.slice(Math.max(0, index - 4), index).some((previous) => /\b(?:suggested|recommended|optional)\b.*\b(?:tip|gratuity)/i.test(previous))),
    /^(?:tip|gratuity)(?:\s+(?:paid|amount))?\s*(?=[:=\d₱$€£-]|PHP\b|USD\b|EUR\b|GBP\b)/i),
    discount: printedAmount(lines, /^(?:total\s+)?discount(?:s|\s+amount)?\b\s*(?=[:=\d₱$€£-]|PHP\b|USD\b|EUR\b|GBP\b)/i, true),
    paymentMethod: printedPayment(lines),
    receiptNumber: receiptNumbers.size === 1 ? [...receiptNumbers][0]! : null,
  };
}
