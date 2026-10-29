// Writes a .gz beside every compressible build asset, for nginx's
// `gzip_static on` (see nginx/templates/finsight.conf.template).
//
// nginx would otherwise gzip the same unchanging bundle again on every
// request, at the fast low level it can afford per request. Done once here at
// the maximum level, the files are smaller and the per-request CPU cost is
// gone. Fonts (woff2) and images are already compressed and are skipped.
//
// Run by web/Dockerfile after `npm run build`; not part of the build itself,
// so a local `dist/` stays free of .gz files.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { constants, gzipSync } from "node:zlib";

const COMPRESSIBLE = new Set([".js", ".css", ".svg", ".json", ".html", ".txt", ".map"]);
// nginx's gzip_min_length for dynamic gzip; below this a gzip frame can be
// larger than the file it wraps.
const MIN_BYTES = 1024;

export function precompress(root) {
  let written = 0;
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath ?? entry.path, entry.name);
    if (!COMPRESSIBLE.has(path.extname(entry.name)) || statSync(filePath).size < MIN_BYTES) continue;
    const source = readFileSync(filePath);
    const compressed = gzipSync(source, { level: constants.Z_BEST_COMPRESSION });
    // A file that does not shrink is served as it is.
    if (compressed.length >= source.length) continue;
    writeFileSync(`${filePath}.gz`, compressed);
    written++;
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] ?? "dist");
  console.log(`precompress: wrote ${precompress(root)} .gz files under ${root}`);
}
