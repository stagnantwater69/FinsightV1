import { describe, expect, it } from "vitest";
import { safeStoredFileName } from "../../src/services/storage.service";

/**
 * The CSV upload key used to interpolate the client's filename verbatim, so a
 * crafted name could steer the written object key outside the `<profileId>/`
 * prefix every other object in that bucket lives under. These assert the
 * traversal shapes specifically, not just "it returns a string".
 */
describe("safeStoredFileName", () => {
  it("cannot escape its prefix with a path traversal", () => {
    const out = safeStoredFileName("../../other-profile/evil.csv");
    expect(out).not.toContain("/");
    expect(out).not.toContain("..");
    // The full key is built as `${profileId}/${uuid}-${name}` — one segment.
    expect(`4/uuid-${out}`.split("/")).toHaveLength(2);
  });

  it("cannot escape its prefix with backslashes either", () => {
    const out = safeStoredFileName("..\\..\\windows\\evil.csv");
    expect(out).not.toContain("\\");
    expect(out).not.toContain("/");
    expect(out).not.toContain("..");
  });

  it("does not leave a name beginning with a dot", () => {
    // Belt and braces: even with separators gone, a leading ".." would be an
    // odd thing to write into a key.
    expect(safeStoredFileName("...hidden.csv").startsWith(".")).toBe(false);
  });

  it("keeps an ordinary filename recognisable, since it names the download", () => {
    // signedCsvFileUrl reads this back out to name the downloaded file — an
    // owner has to recognise it. Sanitising must not mangle the normal case.
    expect(safeStoredFileName("finsight_sample_expenses.csv")).toBe("finsight_sample_expenses.csv");
    expect(safeStoredFileName("expenses-2026.csv")).toBe("expenses-2026.csv");
  });

  it("replaces spaces and unicode rather than dropping the name", () => {
    const out = safeStoredFileName("my expenses ñ.csv");
    expect(out).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(out).toContain(".csv");
  });

  it("still yields a usable name when everything is stripped", () => {
    expect(safeStoredFileName("///")).toBe("upload.csv");
    expect(safeStoredFileName("")).toBe("upload.csv");
  });

  it("caps the length so the whole key stays inside VARCHAR(255)", () => {
    const out = safeStoredFileName(`${"a".repeat(500)}.csv`);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});
