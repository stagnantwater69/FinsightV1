import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_ROOT = path.join(WEB_ROOT, "public");
const INDEX_HTML = fs.readFileSync(path.join(WEB_ROOT, "index.html"), "utf8");

const ICONS = [
  {
    href: "/favicon-newmascot-v2-48.png",
    link: '<link rel="icon" type="image/png" sizes="48x48" href="/favicon-newmascot-v2-48.png" />',
    size: 48,
  },
  {
    href: "/apple-touch-icon-newmascot-v2-180.png",
    link: '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-newmascot-v2-180.png" />',
    size: 180,
  },
] as const;

function pngHeader(file: string) {
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(0, 8).toString("hex"), `${file} is not a PNG`).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("ascii"), `${file} has no leading IHDR`).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
  };
}

describe("site icons", () => {
  it("links only the cache-busted mascot icons", () => {
    for (const icon of ICONS) expect(INDEX_HTML).toContain(icon.link);
    expect(INDEX_HTML).not.toContain('href="/favicon-48.png"');
    expect(INDEX_HTML).not.toContain('href="/favicon-180.png"');
  });

  it.each(ICONS)("ships $href as a square RGBA PNG", ({ href, size }) => {
    const file = path.join(PUBLIC_ROOT, href.slice(1));
    expect(fs.existsSync(file), `${href} is missing from web/public`).toBe(true);
    expect(pngHeader(file)).toEqual({ width: size, height: size, colorType: 6 });
  });
});
