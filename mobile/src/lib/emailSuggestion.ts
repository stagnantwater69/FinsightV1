/**
 * "Did you mean gmail.com?" — catching the typo no validator can catch.
 *
 * `proximate69@gmail.co` is a PERFECTLY VALID address. `.co` is Colombia's
 * TLD, `zod.email()` accepts it, and so does every RFC-correct check. It is
 * also, essentially always, a slip for `.com` — and the cost of that slip is
 * unusually high here: the confirmation email goes to an address the owner
 * does not read, registration appears to succeed (it must, or the form becomes
 * an account-enumeration oracle), and they are left waiting for a message that
 * will never arrive with nothing on screen suggesting why.
 *
 * So this SUGGESTS, and never blocks. Rejecting `.co` would lock out a
 * legitimate Colombian address to save a typo, which is the wrong trade. The
 * owner stays in control: the suggestion is one tap to accept and free to
 * ignore.
 */

/**
 * Domains common enough that a near-miss is worth flagging, plus the ones that
 * would otherwise be flagged AS near-misses.
 *
 * `mail.com` and `gmx.com` are one edit from `gmail.com` and `gmx.de`
 * respectively — real addresses that must never be second-guessed. Listing
 * them here makes them exact matches, so they short-circuit before any
 * distance is computed.
 */
const KNOWN_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "msn.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  // Not typo targets — listed so they are never *offered* a correction.
  "mail.com",
  "gmx.com",
  "yandex.com",
  "me.com",
  "mac.com",
  "qq.com",
];

/** Standard iterative Levenshtein, two rows rather than a full matrix. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * The corrected address, or null when there is nothing worth saying.
 *
 * Deliberately conservative — a suggestion that fires on a correct address is
 * worse than one that stays quiet, because it teaches the owner to dismiss the
 * hint without reading it.
 */
export function suggestEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();

  // One "@", something on each side. Anything else is a different problem, and
  // the field's own validation already speaks to it.
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  if (email.indexOf("@") !== at) return null;

  // Only the domain is ever in question; the local part is rebuilt from the
  // caller's original string at the end so their casing survives.
  const domain = email.slice(at + 1);

  // Already a domain we recognise: say nothing.
  if (KNOWN_DOMAINS.includes(domain)) return null;

  // A subdomained or corporate address (mail.company.co.uk) is not a typo of a
  // consumer provider, and guessing at one would be noise.
  if (domain.split(".").length > 2) return null;

  let best: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of KNOWN_DOMAINS) {
    const distance = editDistance(domain, candidate);
    /*
     * Threshold scales with length: two edits on a long domain is still
     * plainly the same word ("hotmial.con"), but on a short one it is a
     * different domain entirely. Without this, `x.io` would be "corrected" to
     * `zoho.com`.
     */
    const limit = candidate.length >= 9 ? 2 : 1;
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  if (!best) return null;

  // Rebuild from the ORIGINAL local part so casing the owner chose survives;
  // only the domain was ever in question.
  return `${raw.trim().slice(0, raw.trim().lastIndexOf("@"))}@${best}`;
}
