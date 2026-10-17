import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repoRoot, "backend/package.json"));
const ts = require("typescript");

const key = (value) => JSON.stringify(value);
const sorted = (values) => values.sort((a, b) => key(a).localeCompare(key(b), "en"));

function union(members) {
  const unique = new Map(members.map((member) => [key(member), member]));
  if (unique.has('"false"') && unique.has('"true"')) {
    unique.delete('"false"');
    unique.delete('"true"');
    unique.set('"boolean"', "boolean");
  }
  const values = sorted([...unique.values()]);
  return values.length === 1 ? values[0] : { kind: "union", members: values };
}

export function inspectContracts(filePaths) {
  const program = ts.createProgram([...new Set(filePaths.map((file) => path.resolve(file)))], {
    strict: true,
    exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    types: [],
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const diagnostics = new Map();

  function assertDeclarations(symbol) {
    for (const declaration of symbol?.declarations ?? []) {
      if (!ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration)) continue;
      const source = declaration.getSourceFile();
      if (!diagnostics.has(source)) diagnostics.set(source, [
        ...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source),
      ]);
      const error = diagnostics.get(source).find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error &&
        diagnostic.start >= declaration.pos && diagnostic.start < declaration.end);
      if (error) throw new Error(`${symbol.name}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
    }
  }

  function exportsFrom(files) {
    const exported = new Map();
    for (const file of files) {
      const source = program.getSourceFile(path.resolve(file));
      if (!source) throw new Error(`Cannot read contract file: ${file}`);
      const errors = program.getSyntacticDiagnostics(source);
      if (errors.length) throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, " "));
      const module = checker.getSymbolAtLocation(source);
      if (!module) continue;
      for (const symbol of checker.getExportsOfModule(module)) {
        const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        if (!(target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) continue;
        if (exported.has(symbol.name)) throw new Error(`Duplicate exported contract name: ${symbol.name}`);
        exported.set(symbol.name, target);
      }
    }
    return exported;
  }

  function shape(type, fieldPath, ancestors = new Map()) {
    assertDeclarations(type.aliasSymbol ?? type.symbol);
    if (type.flags & ts.TypeFlags.Any) throw new Error(`${fieldPath}: unverifiable any (check unresolved imports)`);
    for (const [flag, name] of [
      [ts.TypeFlags.Unknown, "unknown"], [ts.TypeFlags.Never, "never"],
      [ts.TypeFlags.Null, "null"], [ts.TypeFlags.Undefined, "undefined"],
      [ts.TypeFlags.Void, "void"], [ts.TypeFlags.String, "string"],
      [ts.TypeFlags.Number, "number"], [ts.TypeFlags.Boolean, "boolean"],
      [ts.TypeFlags.BigInt, "bigint"], [ts.TypeFlags.ESSymbol, "symbol"],
      [ts.TypeFlags.NonPrimitive, "object"],
    ]) {
      if (type.flags & flag) return name;
    }
    if (type.flags & ts.TypeFlags.StringLiteral) return { kind: "literal", value: type.value };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { kind: "literal", value: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName;
    if (type.isUnion()) return union(type.types.map((member) => shape(member, fieldPath, ancestors)));
    if (ancestors.has(type)) return { kind: "recursive", distance: ancestors.size - ancestors.get(type) };
    const next = new Map(ancestors);
    next.set(type, ancestors.size);
    if (checker.isTupleType(type)) {
      return {
        kind: "tuple",
        readonly: Boolean(type.target.readonly),
        elements: checker.getTypeArguments(type).map((member, index) => ({
          flags: type.target.elementFlags[index],
          type: shape(member, `${fieldPath}[${index}]`, next),
        })),
      };
    }
    const readonlyArray = type.symbol?.name === "ReadonlyArray";
    if (checker.isArrayType(type) || readonlyArray) {
      return { kind: "array", readonly: readonlyArray, element: shape(checker.getTypeArguments(type)[0], `${fieldPath}[]`, next) };
    }
    if (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
      if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
          checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length) {
        throw new Error(`${fieldPath}: callable types are not API data contracts`);
      }
      const properties = Object.create(null);
      for (const property of checker.getPropertiesOfType(type).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (!declaration) throw new Error(`${fieldPath}.${property.name}: property has no declaration`);
        properties[property.name] = {
          optional: Boolean(property.flags & ts.SymbolFlags.Optional),
          type: shape(checker.getTypeOfSymbolAtLocation(property, declaration), `${fieldPath}.${property.name}`, next),
        };
      }
      return {
        kind: "object", properties,
        indexes: sorted(checker.getIndexInfosOfType(type).map((index) => ({
          key: shape(index.keyType, `${fieldPath}[key]`, next),
          type: shape(index.type, `${fieldPath}[value]`, next),
        }))),
      };
    }
    throw new Error(`${fieldPath}: unsupported contract type ${checker.typeToString(type)}`);
  }

  return {
    exportsFrom,
    shapeOf: (symbol) => shape(checker.getDeclaredTypeOfSymbol(symbol), symbol.name),
  };
}

function description(shape) {
  if (typeof shape === "string") return shape;
  if (shape.kind === "literal") return JSON.stringify(shape.value);
  if (shape.kind === "union") return shape.members.map(description).join(" | ");
  if (shape.kind === "array") return `${shape.readonly ? "readonly " : ""}(${description(shape.element)})[]`;
  if (shape.kind === "object") return `{ ${Object.keys(shape.properties).join(", ")} }`;
  if (shape.kind === "tuple") return `${shape.readonly ? "readonly " : ""}[${shape.elements.map((element) => description(element.type)).join(", ")}]`;
  return "recursive reference";
}

export function shapeDifferences(web, mobile, fieldPath) {
  if (key(web) === key(mobile)) return [];
  if (web?.kind === "object" && mobile?.kind === "object") {
    const differences = [];
    const names = [...new Set([...Object.keys(web.properties), ...Object.keys(mobile.properties)])].sort();
    for (const name of names) {
      const left = web.properties[name];
      const right = mobile.properties[name];
      const nextPath = `${fieldPath}.${name}`;
      if (!left || !right) differences.push(`${nextPath}: missing from ${left ? "mobile" : "web"}`);
      else {
        if (left.optional !== right.optional) differences.push(`${nextPath}: web ${left.optional ? "optional" : "required"}, mobile ${right.optional ? "optional" : "required"}`);
        differences.push(...shapeDifferences(left.type, right.type, nextPath));
      }
    }
    if (key(web.indexes) !== key(mobile.indexes)) differences.push(`${fieldPath}[index]: index key/value types differ`);
    return differences;
  }
  if (web?.kind === "array" && mobile?.kind === "array" && web.readonly === mobile.readonly) {
    return shapeDifferences(web.element, mobile.element, `${fieldPath}[]`);
  }
  if (web?.kind === "union" && mobile?.kind === "union") {
    const common = web.members.filter((member) => mobile.members.some((other) => key(member) === key(other)));
    const left = web.members.filter((member) => !common.some((other) => key(member) === key(other)));
    const right = mobile.members.filter((member) => !common.some((other) => key(member) === key(other)));
    if (left.length === 1 && right.length === 1) return shapeDifferences(left[0], right[0], fieldPath);
  }
  return [`${fieldPath}: web ${description(web)}, mobile ${description(mobile)}`];
}
