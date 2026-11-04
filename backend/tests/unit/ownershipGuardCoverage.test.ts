import { join, relative, sep } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

// Controllers receive businessProfileId from the client. A service function that
// takes that id without a userId trusts its caller to have checked ownership, so
// controllers must never call one directly, and every such function is pinned
// below so a new one gets reviewed instead of slipping in.
const backendRoot = join(__dirname, "../..");

// Functions reached only after an ownership check upstream, or only from
// workers/scripts that load the profile from a stored row.
const REVIEWED_PROFILE_TRUSTING_EXPORTS = [
  "src/lib/categoryHistory.ts#loadConfirmedCategoryHistory",
  "src/services/anomalyDetection/categoryStatistics.service.ts#loadBoundedCategoryHistory",
  "src/services/anomalyDetection/categoryStatistics.service.ts#loadBoundedCategoryHistoryForCategories",
  "src/services/anomalyDetection/categoryStatistics.service.ts#loadCategoryHistoryCoverage",
  "src/services/anomalyDetection/finding.service.ts#saveFinding",
  "src/services/anomalyDetection/job.service.ts#enqueueExpenseAnalyses",
  "src/services/anomalyDetection/job.service.ts#enqueueProfileRefresh",
  "src/services/anomalyDetection/nearDuplicate.service.ts#scoreNearDuplicate",
  "src/services/csvImport.service.ts#resolveCategories",
  "src/services/csvSourcePurge.service.ts#enqueueDetachedCsvSourcePurge",
  "src/services/csvStorageReconciliation.service.ts#reconcileCsvStorageProfile",
  "src/services/extractionFeedback.service.ts#loadCorrections",
  "src/services/extractionFeedback.service.ts#recordDeletedLine",
  "src/services/operatingCalendar.service.ts#resolveExactOperatingCounts",
  "src/services/operatingCalendar.service.ts#resolveOperatingCalendar",
  "src/services/receiptCaptureBatch.service.ts#validateReceiptCaptureBatchSlot",
  "src/services/receiptProviderDispatch.service.ts#dispatchReceiptProviderRescue",
  "src/services/receiptScan/dto.ts#toDTO",
  "src/services/receiptScan/extraction.ts#snapVendorToHistory",
  "src/services/receiptScan/worker.ts#persistReceiptProcessingOutput",
  "src/services/storage.service.ts#csvFileReference",
  "src/services/storage.service.ts#listCsvFilesForProfile",
  "src/services/storage.service.ts#uploadBusinessLogo",
  "src/services/storage.service.ts#uploadCsvFile",
  "src/services/storage.service.ts#uploadCsvFileAtReference",
  "src/services/storage.service.ts#uploadReceiptImage",
];

const PROFILE_ID = /^(businessProfileId|profileId)$/;
const USER_ID = /^(userId|user|ownerId)$/;

let profileTrusting: Map<ts.Symbol, string>;
let program: ts.Program;
let checker: ts.TypeChecker;

const relPath = (file: string) => relative(backendRoot, file).split(sep).join("/");
const sourceFiles = (prefix: string) =>
  program.getSourceFiles().filter((sf) => relPath(sf.fileName).startsWith(prefix));

function parameterNames(fn: ts.SignatureDeclaration): string[] {
  const names: string[] = [];
  for (const param of fn.parameters) {
    if (ts.isIdentifier(param.name)) names.push(param.name.text);
    else for (const el of param.name.elements) {
      if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.push(el.name.text);
    }
    for (const prop of checker.getTypeAtLocation(param).getProperties()) names.push(prop.name);
  }
  return names;
}

function exportedFunctions(sf: ts.SourceFile): Array<{ name: ts.Identifier; fn: ts.SignatureDeclaration }> {
  const found: Array<{ name: ts.Identifier; fn: ts.SignatureDeclaration }> = [];
  for (const stmt of sf.statements) {
    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) found.push({ name: stmt.name, fn: stmt });
    if (ts.isVariableStatement(stmt)) for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        found.push({ name: decl.name, fn: init });
      }
    }
  }
  return found;
}

function resolved(node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

beforeAll(() => {
  const config = ts.getParsedCommandLineOfConfigFile(join(backendRoot, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
  });
  if (!config) throw new Error("Could not read backend tsconfig.json");
  program = ts.createProgram(config.fileNames, config.options);
  checker = program.getTypeChecker();

  profileTrusting = new Map();
  for (const sf of sourceFiles("src/")) {
    for (const { name, fn } of exportedFunctions(sf)) {
      const params = parameterNames(fn);
      if (!params.some((p) => PROFILE_ID.test(p)) || params.some((p) => USER_ID.test(p))) continue;
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) profileTrusting.set(symbol, `${relPath(sf.fileName)}#${name.text}`);
    }
  }
});

describe("ownership guard coverage", () => {
  it("finds the exported functions it is guarding", () => {
    expect(profileTrusting.size).toBeGreaterThan(0);
  });

  it("never lets a controller call a function that trusts a client-supplied business profile id", () => {
    const violations: string[] = [];
    for (const sf of sourceFiles("src/controllers/")) {
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          const target = resolved(callee);
          const key = target && profileTrusting.get(target);
          if (key) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            violations.push(`${relPath(sf.fileName)}:${line} calls ${key}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(violations).toEqual([]);
  });

  it("pins every exported function that takes a business profile id without a user id", () => {
    // A new entry here needs an ownership check in every request-facing caller
    // (requireOwnedBusinessProfile or a `businessProfile: { userId }` filter).
    expect([...profileTrusting.values()].sort()).toEqual([...REVIEWED_PROFILE_TRUSTING_EXPORTS].sort());
  });
});
