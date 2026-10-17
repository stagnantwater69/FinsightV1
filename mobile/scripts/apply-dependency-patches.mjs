import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function safeRelativePath(value) {
  return typeof value === "string" && !isAbsolute(value) &&
    /^[\w@./+-]+$/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function gitEnvironment(stage) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  // Git must not discover a parent checkout and silently ignore staged paths.
  // Git for Windows rejects os.devNull (\\.\nul) as a config path but maps /dev/null itself.
  const nullConfig = process.platform === "win32" ? "/dev/null" : devNull;
  return { ...env, GIT_CEILING_DIRECTORIES: dirname(stage), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullConfig };
}

function runGit(stage, args) {
  const result = spawnSync("git", args, { cwd: stage, env: gitEnvironment(stage), encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Compatibility patch failed: ${result.error?.message || result.stderr.trim() || "Git is unavailable"}`);
  }
}

export async function applyDependencyPatches(projectRoot = mobileRoot) {
  const patchesRoot = resolve(projectRoot, "patches");
  const manifest = JSON.parse(await readFile(resolve(patchesRoot, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest) || manifest.length !== 3) throw new Error("Expected three compatibility patches");
  const nodeModulesRoot = await realpath(resolve(projectRoot, "node_modules"));
  const seen = new Set();
  const groups = [];

  for (const patch of manifest) {
    if (!safeRelativePath(patch.packageName) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(patch.version) ||
      !/^[\w@.+-]+\.patch$/.test(patch.patchFile) || !validHash(patch.patchSha256) || !Array.isArray(patch.files)) {
      throw new Error("Invalid compatibility patch manifest");
    }
    const installed = JSON.parse(await readFile(resolve(projectRoot, "node_modules", patch.packageName, "package.json"), "utf8"));
    if (installed.version !== patch.version) throw new Error(`Compatibility patch version mismatch: ${patch.packageName}`);
    const patchPath = resolve(patchesRoot, patch.patchFile);
    const patchBytes = await readFile(patchPath);
    if (hash(patchBytes) !== patch.patchSha256) throw new Error(`Compatibility patch hash mismatch: ${patch.patchFile}`);
    const patchText = patchBytes.toString("utf8");
    if (/^Binary files|^GIT binary patch|^new file mode|^deleted file mode|^rename /m.test(patchText)) {
      throw new Error("Compatibility patches may only modify existing text files");
    }
    const headers = Array.from(patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm));
    const allowedPaths = new Set(patch.files.map((file) => file.path));
    if (headers.length !== patch.files.length || allowedPaths.size !== patch.files.length ||
      headers.some((header) => header[1] !== header[2] || !allowedPaths.has(header[1]))) {
      throw new Error(`Unexpected compatibility patch paths: ${patch.patchFile}`);
    }
    const files = [];
    for (const file of patch.files) {
      if (!safeRelativePath(file.path) || !file.path.startsWith(`node_modules/${patch.packageName}/`) ||
        !validHash(file.beforeSha256) || !validHash(file.afterSha256) || seen.has(file.path)) {
        throw new Error("Invalid or duplicate compatibility patch target");
      }
      seen.add(file.path);
      const target = resolve(projectRoot, file.path);
      const targetInfo = await lstat(target);
      const resolvedTarget = await realpath(target);
      if (!targetInfo.isFile() || !resolvedTarget.startsWith(`${nodeModulesRoot}${sep}`)) {
        throw new Error(`Unsafe compatibility patch target: ${file.path}`);
      }
      const original = await readFile(target);
      const originalHash = hash(original);
      if (originalHash !== file.beforeSha256 && originalHash !== file.afterSha256) {
        throw new Error(`Compatibility patch source hash mismatch: ${file.path}`);
      }
      files.push({ ...file, target, original, originalHash, mode: targetInfo.mode });
    }
    const alreadyApplied = files.every((file) => file.originalHash === file.afterSha256);
    if (!alreadyApplied && files.some((file) => file.originalHash !== file.beforeSha256)) {
      throw new Error(`Partially applied compatibility patch; run npm ci: ${patch.packageName}`);
    }
    groups.push({ ...patch, patchPath, files, alreadyApplied });
  }
  if (seen.size !== 15) throw new Error("Expected fifteen compatibility patch targets");
  if (groups.every((group) => group.alreadyApplied)) {
    console.log("Compatibility patches already applied (15 verified files).");
    return;
  }

  const stage = await mkdtemp(resolve(tmpdir(), "finsight-dependency-patches-"));
  const prepared = [];
  const committed = [];
  try {
    for (const group of groups) {
      for (const file of group.files) {
        const stagedTarget = resolve(stage, file.path);
        await mkdir(dirname(stagedTarget), { recursive: true });
        await writeFile(stagedTarget, file.original);
      }
    }
    for (const group of groups.filter((group) => !group.alreadyApplied)) {
      runGit(stage, ["apply", "--check", "--whitespace=nowarn", group.patchPath]);
      runGit(stage, ["apply", "--whitespace=nowarn", group.patchPath]);
    }
    for (const group of groups) {
      for (const file of group.files) {
        const output = await readFile(resolve(stage, file.path));
        if (hash(output) !== file.afterSha256) throw new Error(`Compatibility patch output hash mismatch: ${file.path}`);
        if (group.alreadyApplied) continue;
        const id = randomUUID();
        const update = `${file.target}.finsight-update-${id}`;
        const backup = `${file.target}.finsight-backup-${id}`;
        const entry = { ...file, update, backup };
        prepared.push(entry);
        await writeFile(update, output, { flag: "wx", mode: file.mode });
        await writeFile(backup, file.original, { flag: "wx", mode: file.mode });
      }
    }
    for (const file of prepared) {
      if (hash(await readFile(file.target)) !== file.originalHash) throw new Error(`Compatibility patch target changed during install: ${file.path}`);
    }
    for (const file of prepared) {
      await rename(file.update, file.target);
      committed.push(file);
    }
    console.log(`Applied compatibility patches (${prepared.length} files; all 15 outputs verified).`);
  } catch (error) {
    for (const file of committed.reverse()) await rename(file.backup, file.target);
    throw error;
  } finally {
    await Promise.all(prepared.flatMap((file) => [file.update, file.backup]).map((file) => rm(file, { force: true })));
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await applyDependencyPatches();
}
