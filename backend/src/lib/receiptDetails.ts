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

function printedCurrencies(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(`(?:\\bcurrency\\s*[:=]?\\s*|\\b)(${CURRENCY_CODES})\\b(?=\\s*(?:[:=]?\\s*[-+]?\\d|$))`, "gim"))) {
    found.add(match[1]!.toUpperCase());
  }
  for (const match of text.matchAll(new RegExp(`\\d\\s*(${CURRENCY_CODES})\\b`, "gi"))) found.add(match[1]!.toUpperCase());
  // A symbol counts only on a printed amount ("£12.50"), never on its own:
  // OCR of a logo or a decorative rule throws off stray "£" and "$" characters,
  // and one of those must not turn a peso receipt into a foreign-currency one.
  // Philippine registers print pesos as a bare "P" before the amount.
  // Horizontal space only, any amount of it: a receipt column right-aligns its
  // figures, so "US$      12.50" is one printed amount, while `\s` would let a
  // symbol on one line pair with a number on the next and invent a currency.
  const symbols: [RegExp, string][] = [
    [/(?:₱|\bP)[ \t]*\d[\d,]*[.,][ \t]*\d{2}\b/, "PHP"],
    [/€[ \t]*\d[\d,]*[.,]\d{2}\b/, "EUR"],
    [/£[ \t]*\d[\d,]*[.,]\d{2}\b/, "GBP"],
    [/\bUS\$[ \t]*\d/, "USD"],
    [/\b(?:AU|A)\$[ \t]*\d/, "AUD"],
    [/\b(?:CA|C)\$[ \t]*\d/, "CAD"],
    [/\bNZ\$[ \t]*\d/, "NZD"],
    [/\b(?:SG|S)\$[ \t]*\d/, "SGD"],
    [/\bHK\$[ \t]*\d/, "HKD"],
  ];
  for (const [pattern, code] of symbols) if (pattern.test(text)) found.add(code);
  return found;
}

export function requiresManualCurrencyConversion(rawText: string | null | undefined): boolean {
  const text = rawText ?? "";
  // Dollar and yen/yuan symbols do not identify one exact currency, but they
  // still must not be booked as PHP. Keep the displayed currency unknown and
  // require the owner to enter the actual PHP amount paid.
  return /[$¥￥][ \t]*\d/.test(text) || [...printedCurrencies(text)].some((currency) => currency !== "PHP");
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
  const currencies = printedCurrencies(text);
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
