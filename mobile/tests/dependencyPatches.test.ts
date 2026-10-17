import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

type Target = { path: string; beforeSha256: string; afterSha256: string };
type Patch = { packageName: string; version: string; patchFile: string; files: Target[] };
const mobile = resolve(__dirname, '..');
const patches = JSON.parse(readFileSync(join(mobile, 'patches/manifest.json'), 'utf8')) as Patch[];
const targets = patches.flatMap((patch) => patch.files);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cleanups: string[] = [];
const git = 'git';
const isolatedEnv = () => ({ ...process.env, NODE_OPTIONS: '' });

function makeFixture() {
  const outer = mkdtempSync(join(tmpdir(), 'finsight-patch-test-'));
  cleanups.push(outer);
  const root = join(outer, 'mobile');
  mkdirSync(join(root, 'patches'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(mobile, 'scripts/apply-dependency-patches.mjs'), join(root, 'scripts/apply-dependency-patches.mjs'));
  copyFileSync(join(mobile, 'patches/manifest.json'), join(root, 'patches/manifest.json'));
  for (const patch of patches) {
    const packageRoot = join(root, 'node_modules', patch.packageName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: patch.packageName, version: patch.version }));
    copyFileSync(join(mobile, 'patches', patch.patchFile), join(root, 'patches', patch.patchFile));
    for (const target of patch.files) {
      const bytes = readFileSync(join(mobile, target.path));
      expect(hash(bytes)).toBe(target.afterSha256);
      mkdirSync(dirname(join(root, target.path)), { recursive: true });
      writeFileSync(join(root, target.path), bytes);
    }
  }
  const env = Object.fromEntries(Object.entries(isolatedEnv()).filter(([key]) => !key.startsWith('GIT_')));
  for (const patch of patches) {
    const reverse = spawnSync(git, ['-c', 'core.autocrlf=false', 'apply', '--reverse', '--whitespace=nowarn', join(root, 'patches', patch.patchFile)], {
      cwd: root, env: { ...env, NODE_ENV: process.env.NODE_ENV, GIT_CEILING_DIRECTORIES: outer }, encoding: 'utf8',
    });
    expect(reverse.status, reverse.stderr).toBe(0);
  }
  expect(snapshot(root)).toEqual(Object.fromEntries(targets.map((target) => [target.path, target.beforeSha256])));
  return { outer, root };
}

function snapshot(root: string, excludedPaths: readonly string[] = []) {
  return Object.fromEntries(targets.filter((target) => !excludedPaths.includes(target.path))
    .map((target) => [target.path, hash(readFileSync(join(root, target.path)))]));
}

function run(root: string, options: { env?: Partial<NodeJS.ProcessEnv>; preload?: string } = {}) {
  const args = options.preload ? ['--require', options.preload] : [];
  return spawnSync(process.execPath, [...args, join(root, 'scripts/apply-dependency-patches.mjs')], {
    cwd: dirname(root), env: { ...isolatedEnv(), ...options.env }, encoding: 'utf8', timeout: 10000,
  });
}

function expectFailureWithoutWrites(root: string, expectedMessage: RegExp, options?: Parameters<typeof run>[1], excludedPaths: readonly string[] = []) {
  const before = snapshot(root, excludedPaths);
  const result = run(root, options);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(expectedMessage);
  expect(snapshot(root, excludedPaths)).toEqual(before);
  expect(readdirSync(join(root, 'node_modules'), { recursive: true }).filter((path) => /finsight-(?:update|backup)-/.test(String(path)))).toEqual([]);
}

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Dependency compatibility patch install runner', () => {
  it('applies all exact outputs and safely repeats without changing them', () => {
    const { root } = makeFixture();
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    const expected = Object.fromEntries(targets.map((target) => [target.path, target.afterSha256]));
    expect(snapshot(root)).toEqual(expected);
    const repeat = run(root);
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(repeat.stdout).toContain('already applied');
    expect(snapshot(root)).toEqual(expected);
  });

  it('rejects a version mismatch in the last package before modifying any package', () => {
    const { root } = makeFixture();
    const last = patches[patches.length - 1]!;
    writeFileSync(join(root, 'node_modules', last.packageName, 'package.json'), JSON.stringify({ version: '99.0.0' }));
    expectFailureWithoutWrites(root, /version mismatch/);
  });

  it('rejects a tampered final input without partially modifying earlier packages', () => {
    const { root } = makeFixture();
    const target = targets[targets.length - 1]!;
    writeFileSync(join(root, target.path), 'tampered dependency content');
    expectFailureWithoutWrites(root, /source hash mismatch/);
  });

  it('rejects altered patch content before invoking Git', () => {
    const { root } = makeFixture();
    writeFileSync(join(root, 'patches', patches[2]!.patchFile), 'untrusted replacement patch');
    expectFailureWithoutWrites(root, /patch hash mismatch/);
  });

  it('rejects a partially patched package rather than guessing its contents', () => {
    const { root } = makeFixture();
    const target = targets[0]!;
    copyFileSync(join(mobile, target.path), join(root, target.path));
    expectFailureWithoutWrites(root, /Partially applied compatibility patch/);
  });

  it('preserves a fully patched package while applying the remaining packages', () => {
    const { root } = makeFixture();
    for (const target of patches[0]!.files) copyFileSync(join(mobile, target.path), join(root, target.path));
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('11 files');
    expect(snapshot(root)).toEqual(Object.fromEntries(targets.map((target) => [target.path, target.afterSha256])));
  });

  it(process.platform === 'win32'
    ? 'rejects a target directory junction and leaves external files unchanged'
    : 'rejects a target file symlink and leaves the external file unchanged', () => {
    const { outer, root } = makeFixture();
    const target = targets[targets.length - 1]!;
    const externalDirectory = join(outer, 'external-directory');
    mkdirSync(externalDirectory);
    const external = join(externalDirectory, 'external-source.tsx');
    copyFileSync(join(root, target.path), external);
    rmSync(join(root, target.path));
    const targetPath = join(root, target.path);
    // Windows file links require privileges unavailable here; Linux exercises the actual file link.
    const linkedPath = process.platform === 'win32' ? externalDirectory : external;
    symlinkSync(linkedPath, targetPath, process.platform === 'win32' ? 'junction' : 'file');
    const linkedStat = lstatSync(targetPath);
    expect(linkedStat.isSymbolicLink()).toBe(true);
    expect(realpathSync(targetPath)).toBe(realpathSync(linkedPath));
    const excludedPaths = process.platform === 'win32' ? [target.path] : [];
    expect(Object.keys(snapshot(root, excludedPaths))).toHaveLength(targets.length - excludedPaths.length);
    expectFailureWithoutWrites(root, /Unsafe compatibility patch target/, undefined, excludedPaths);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(targetPath).ino).toBe(linkedStat.ino);
    expect(realpathSync(targetPath)).toBe(realpathSync(linkedPath));
    expect(hash(readFileSync(external))).toBe(target.beforeSha256);
  });

  it('rejects an unexpected staged output before committing any dependency file', () => {
    const { root } = makeFixture();
    const altered = structuredClone(patches);
    altered[2]!.files[2]!.afterSha256 = '0'.repeat(64);
    writeFileSync(join(root, 'patches/manifest.json'), JSON.stringify(altered));
    expectFailureWithoutWrites(root, /output hash mismatch/);
  });

  it('fails closed when Git is unavailable', () => {
    const { outer, root } = makeFixture();
    const emptyPath = join(outer, 'empty-path');
    mkdirSync(emptyPath);
    expectFailureWithoutWrites(root, /Compatibility patch failed.*ENOENT/, { env: { PATH: emptyPath } });
  });

  it('ignores inherited Git settings and parent repositories, including a nested temporary directory', () => {
    const { outer, root } = makeFixture();
    const init = spawnSync(git, ['-c', 'init.defaultBranch=main', 'init', outer], { encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    const nestedTmp = join(outer, 'nested-tmp');
    mkdirSync(nestedTmp);
    const result = run(root, { env: {
      TMPDIR: nestedTmp, GIT_DIR: join(outer, '.git'), GIT_WORK_TREE: outer,
      GIT_INDEX_FILE: join(outer, 'forbidden-index'), GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'apply.ignoreWhitespace', GIT_CONFIG_VALUE_0: 'garbage',
    } });
    expect(result.status, result.stderr).toBe(0);
    expect(snapshot(root)).toEqual(Object.fromEntries(targets.map((target) => [target.path, target.afterSha256])));
    expect(readdirSync(nestedTmp)).toEqual([]);
  });

  it('restores previously committed files when a later rename fails', () => {
    const { outer, root } = makeFixture();
    const preload = join(outer, 'fail-second-commit.cjs');
    writeFileSync(preload, `const fs = require('node:fs/promises');
const rename = fs.rename;
let commits = 0;
fs.rename = async (from, to) => {
  if (from.includes('.finsight-update-') && ++commits === 2) throw new Error('Injected commit failure');
  return rename(from, to);
};
require('node:module').syncBuiltinESMExports();
`);
    expectFailureWithoutWrites(root, /Injected commit failure/, { preload });
  });
});

describe('React DevTools shell quoting', () => {
  const require = createRequire(import.meta.url);
  const devtoolsRequire = createRequire(require.resolve('react-devtools-core'));
  const { quote } = devtoolsRequire('shell-quote') as { quote: (tokens: Array<string | { comment: string }>) => string };

  it('rejects a command token containing a line terminator after a comment', () => {
    expect(() => quote(['echo', 'ok', { comment: 'x' }, 'a\nprintf SHELL_QUOTE_POC;#'])).toThrow(TypeError);
  });

  it('preserves quoting for ordinary tokens containing spaces and shell metacharacters', () => {
    expect(quote(['echo', 'hello world', '$HOME', 'a;b'])).toBe("echo 'hello world' \\$HOME a\\;b");
  });
});
