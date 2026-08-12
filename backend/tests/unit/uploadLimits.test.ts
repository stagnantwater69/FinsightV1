import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PAGES } from "../../src/services/receiptScan.service";

/**
 * The edge and the application have to agree about how big an upload can be.
 *
 * THE BUG THIS PREVENTS RECURRING. nginx defaults `client_max_body_size` to
 * 1 MB and the config did not override it, while multer accepts 10 MB per
 * receipt photograph and the route accepts MAX_PAGES of them at once. So behind
 * Docker every real receipt upload — the product's headline feature — died on a
 * bare nginx 413 before the backend saw the request: no quality check, no
 * per-file message, nothing the app could explain. It worked under
 * `npm run dev`, where there is no proxy, which is why it went unnoticed.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The two limits live in different
 * languages in different directories, and the one that breaks is the one nobody
 * edits: raising MAX_PAGES is an obvious, local, app-side change that silently
 * reintroduces the failure. This fails CI at that moment instead.
 *
 * It reads the real nginx.conf rather than a copy — a copy would agree with
 * itself forever.
 */

const NGINX_CONF = join(__dirname, "../../../nginx/nginx.conf");

/** Per-file ceiling in `uploadReceiptImage` (upload.middleware.ts), in MB. */
const PER_FILE_MB = 10;

function nginxBodyLimitMb(): number {
  const conf = readFileSync(NGINX_CONF, "utf8");
  const match = /^\s*client_max_body_size\s+(\d+)([mMkK])\s*;/m.exec(conf);
  if (!match) throw new Error("client_max_body_size is not set in nginx.conf — that is the bug this test exists for");
  const value = Number(match[1]);
  return match[2]!.toLowerCase() === "k" ? value / 1024 : value;
}

describe("the upload ceiling at the edge matches what the app accepts", () => {
  it("is set at all", () => {
    // Its absence is the whole failure: nginx then quietly applies 1 MB.
    expect(() => nginxBodyLimitMb()).not.toThrow();
  });

  it("admits a full-size multi-page receipt", () => {
    const worstCase = MAX_PAGES * PER_FILE_MB;
    expect(
      nginxBodyLimitMb(),
      `nginx allows ${nginxBodyLimitMb()}MB but a ${MAX_PAGES}-page receipt at ${PER_FILE_MB}MB each is ${worstCase}MB. ` +
        `Raise client_max_body_size in nginx/nginx.conf, or lower MAX_PAGES.`,
    ).toBeGreaterThanOrEqual(worstCase);
  });

  /**
   * Multipart is not just the sum of the files: each part carries headers and a
   * boundary, and the request also has the ordinary form fields. A ceiling set
   * exactly at the sum would reject an upload that is exactly at the documented
   * per-file limit, which is the most confusing possible place to fail.
   */
  it("leaves headroom for multipart overhead", () => {
    expect(nginxBodyLimitMb()).toBeGreaterThan(MAX_PAGES * PER_FILE_MB);
  });

  /**
   * The other direction matters too. The edge is a backstop, not the rule — the
   * per-file limit belongs to multer, so an oversized single photo gets the
   * app's worded message rather than a bare 413. A wildly larger edge ceiling
   * would mean the server reads tens of megabytes into memory before anything
   * rejects it.
   */
  it("is not so large that the edge stops being a backstop", () => {
    expect(nginxBodyLimitMb()).toBeLessThanOrEqual(MAX_PAGES * PER_FILE_MB * 2);
  });
});
