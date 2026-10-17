import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkParity } from "./check-type-parity.mjs";
import { inspectContracts, shapeDifferences } from "./type-parity.mjs";

const tempRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(tempRoot, "finsight-type-parity-"));
const fixtures = [];

function fixture(name, web, mobile, dependencies = {}) {
  const folder = path.join(scratch, name);
  mkdirSync(folder);
  const files = ["web.ts", "mobile.ts"].map((file, index) => {
    const location = path.join(folder, file);
    writeFileSync(location, [web, mobile][index]);
    return location;
  });
  for (const [file, source] of Object.entries(dependencies)) writeFileSync(path.join(folder, file), source);
  const entry = { name, files, folder };
  fixtures.push(entry);
  return entry;
}

const missingTimezone = fixture("timezone", "export interface Contract { id: number; timezone?: string }", "export interface Contract { id: number }");
const fieldType = fixture("money", "export interface Contract { amount: number }", "export interface Contract { amount: string }");
const optional = fixture("optional", "export interface Contract { periodDays?: number }", "export interface Contract { periodDays: number }");
const nullability = fixture("null", "export interface Contract { cursor: string | null }", "export interface Contract { cursor: string }");
const array = fixture("array", "export interface Contract { items: { amount: number }[] }", "export interface Contract { items: { amount: string }[] }");
const literalUnion = fixture("union", 'export type Contract = "sales" | "expense"', 'export type Contract = "expense"');
const nested = fixture("nested", 'import type { Position } from "./web-dependency"; export interface Contract { position: Position }', 'import type { Position } from "./mobile-dependency"; export interface Contract { position: Position }', {
  "web-dependency.ts": "export interface Position { funds: { amount: number } }",
  "mobile-dependency.ts": "export interface Position { funds: { amount: string } }",
});
const inherited = fixture("inherited", "interface Base { amount: number }; export interface Contract extends Base { id: number }", "interface Base { amount: string }; export interface Contract extends Base { id: number }");
const paging = fixture("paging", "export interface Contract { items: { id: number }[]; nextCursor: string | null }", "export interface Contract { items: { id: number }[]; nextCursor: number | null }");
const sendStatus = fixture("send-status", 'export interface Contract { status: "PROCESSING" | "COMPLETE"; result: { assistantMessage: { content: string } } | null }', 'export interface Contract { status: "PROCESSING" | "COMPLETE"; result: { assistantMessage: { content: number } } | null }');
const branch = fixture("branch", 'export type Contract = { kind: "a"; amount: number } | { kind: "b"; date: string }', 'export type Contract = { date: string; kind: "b" } | { amount: string; kind: "a" }');
const indexSignature = fixture("index", "export interface Contract { [key: string]: number }", "export interface Contract { [key: string]: string }");
const tuple = fixture("tuple", "export type Contract = [number, string]", "export type Contract = [string, number]");
const equivalent = fixture("equivalent", 'type Item = { amount: number; kind: "sales" | "expense" }; export interface Contract { items: Item[]; cursor: string | null }', 'interface Item { kind: "expense" | "sales"; amount: number }; export type Contract = { cursor: null | string; items: Array<Item> }');
const boolean = fixture("boolean", "export type Contract = boolean", "export type Contract = true | false");
const recursive = fixture("recursive", "export interface Contract { amount: number; children: Contract[] }", "export interface Contract { children: Array<Contract>; amount: number }");
const recursiveMutation = fixture("recursive-mutation", "export interface Contract { amount: number; children: Contract[] }", "export interface Contract { children: Array<Contract>; amount: string }");
const optionalOrder = fixture("optional-order", 'export interface Contract { label?: null | string; flag?: boolean }', 'export interface Contract { flag?: false | true; label?: string | null }');
const unresolved = fixture("unresolved", 'import type { Missing } from "./not-present"; export interface Contract { value: Missing }', 'import type { Missing } from "./not-present"; export interface Contract { value: Missing }');
const missingBase = fixture("missing-base", "export interface Contract extends Missing { id: number }", "export interface Contract extends Missing { id: number }");
const any = fixture("any", "export interface Contract { value: any }", "export interface Contract { value: any }");
const callable = fixture("callable", "export type Contract = () => string", "export type Contract = () => string");
const reExport = fixture("re-export", 'export type { Contract } from "./web-dependency"', 'export type { Contract } from "./mobile-dependency"', {
  "web-dependency.ts": "export interface Contract { timezone: string }",
  "mobile-dependency.ts": "export interface Contract { timezone: string }",
});
const names = fixture("names", "export interface Contract { id: number }; export interface WebOnly { uri: string }", "export interface Contract { id: number }");
const inspector = inspectContracts(fixtures.flatMap((entry) => entry.files));

function differences(entry) {
  const [web, mobile] = entry.files.map((file) => inspector.exportsFrom([file]).get("Contract"));
  return shapeDifferences(inspector.shapeOf(web), inspector.shapeOf(mobile), "Contract");
}

for (const [entry, field] of [
  [missingTimezone, "Contract.timezone"], [fieldType, "Contract.amount"], [optional, "Contract.periodDays"],
  [nullability, "Contract.cursor"], [array, "Contract.items[].amount"], [literalUnion, "Contract:"],
  [nested, "Contract.position.funds.amount"], [inherited, "Contract.amount"], [paging, "Contract.nextCursor"],
  [sendStatus, "Contract.result.assistantMessage.content"], [branch, "Contract.amount"],
  [indexSignature, "Contract[index]"], [tuple, "Contract:"], [recursiveMutation, "Contract.amount"],
]) {
  test(`rejects ${entry.name} drift despite matching exported names`, () => {
    const namesByClient = entry.files.map((file) => [...inspector.exportsFrom([file]).keys()]);
    assert.deepEqual(namesByClient[0], namesByClient[1]);
    assert.ok(differences(entry).some((difference) => difference.startsWith(field)), differences(entry).join("\n"));
  });
}

for (const entry of [equivalent, boolean, recursive, optionalOrder, reExport]) {
  test(`accepts equivalent ${entry.name} contracts`, () => assert.deepEqual(differences(entry), []));
}

for (const [entry, message] of [
  [unresolved, /unverifiable any/], [missingBase, /Cannot find name 'Missing'/],
  [any, /unverifiable any/], [callable, /callable types/],
]) {
  test(`fails closed for ${entry.name} contracts`, () => assert.throws(() => differences(entry), message));
}

function groupFor(entry, additions = {}) {
  return { name: entry.name, web: ["web.ts"], mobile: ["mobile.ts"], exempt: {}, knownDrift: {}, ...additions };
}

function check(entry, additions = {}) {
  const output = [];
  const log = { log: (line) => output.push(line), error: (line) => output.push(line) };
  return { passed: checkParity([groupFor(entry, additions)], entry.folder, log), output };
}

test("group check fails missing names and accepts documented platform-only names", () => {
  assert.equal(check(names).passed, false);
  assert.equal(check(names, { exempt: { WebOnly: "web-only local URI" } }).passed, true);
});

test("group check preserves recorded name drift but rejects a stale entry", () => {
  assert.equal(check(names, { knownDrift: { WebOnly: "existing unresolved name" } }).passed, true);
  assert.equal(check(names, { knownDrift: { Contract: "now present on both clients" } }).passed, false);
});

test("group check catches field drift and includes its path", () => {
  const result = check(missingTimezone);
  assert.equal(result.passed, false);
  assert.ok(result.output.some((line) => line.includes("Contract.timezone: missing from mobile")));
});

test("shape-stage exclusions are visible and must be removed when stale", () => {
  const exclusion = { shapeExempt: { Contract: "parsed screen state" } };
  const result = check(missingTimezone, exclusion);
  assert.equal(result.passed, true);
  assert.ok(result.output.some((line) => line.includes("name-only: Contract: parsed screen state")));
  assert.equal(check(equivalent, exclusion).passed, false);
});

after(() => {
  assert.ok(scratch.startsWith(path.join(tempRoot, "finsight-type-parity-")));
  rmSync(scratch, { recursive: true, force: true });
});
