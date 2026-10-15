import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import ts from "typescript";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "searchable-select-migration",
  usage: `searchable-select-migration: rewrite native <select> elements under src/components to
<SearchableSelect>, IN PLACE, and write a report beside them.

  node scripts/searchable-select-migration.mjs      run the codemod on src/components
  node scripts/searchable-select-migration.mjs -h   this text

It takes no arguments and it has NO dry run — running it edits your working tree.`,
  hints: [
    "it has no dry run: it edits src/components in place, so run it on a branch with a clean tree",
    "to see what it would touch first, read the report path at the top of the file from a previous run",
  ],
});

const ROOT_DIR = process.cwd();
const COMPONENTS_DIR = path.join(ROOT_DIR, "src", "components");
const IMPORT_PATH = "@/components/ui/searchable-select";
const IMPORT_LINE = `import { SearchableSelect } from "${IMPORT_PATH}";`;
const REPORT_PATH = path.join(ROOT_DIR, "scripts", "searchable-select-migration-report.json");

const report = {
  migratedAt: new Date().toISOString(),
  totalFilesScanned: 0,
  totalSelects: 0,
  totalConverted: 0,
  totalSkipped: 0,
  files: [],
};

function collectComponentFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectComponentFiles(filePath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".tsx")) {
      files.push(filePath);
    }
  }
  return files;
}

function getSelectNodeName(tagName) {
  if (!tagName) return null;
  if (ts.isIdentifier(tagName) || ts.isJsxNamespacedName(tagName)) {
    return ts.isIdentifier(tagName) ? tagName.text : `${tagName.namespace.text}:${tagName.name.text}`;
  }
  if (ts.isPropertyAccessExpression(tagName)) {
    return tagName.getText();
  }
  return null;
}

function hasMultipleAttribute(attributes) {
  for (const attribute of attributes.properties) {
    if (ts.isJsxAttribute(attribute)) {
      if (attribute.name.text === "multiple") {
        return true;
      }
    }
  }
  return false;
}

function isAllowedSelectChild(node) {
  if (ts.isJsxText(node)) return true;
  if (ts.isJsxElement(node)) {
    const name = getSelectNodeName(node.openingElement.tagName);
    if (name === "option") {
      return node.children.every(isAllowedSelectChild);
    }
    if (name === "optgroup") {
      return node.children.every(isAllowedSelectChild);
    }
    return false;
  }
  if (ts.isJsxSelfClosingElement(node)) {
    const name = getSelectNodeName(node.tagName);
    return name === "option";
  }
  if (ts.isJsxFragment(node)) {
    return node.children.every(isAllowedSelectChild);
  }
  if (ts.isJsxExpression(node)) {
    return true;
  }
  if (ts.isJsxSpreadChild?.(node)) {
    return false;
  }
  return false;
}

function isOptionBasedSelect(openingElement, children) {
  if (!openingElement) return false;
  if (hasMultipleAttribute(openingElement.attributes)) return false;

  for (const child of children) {
    if (!isAllowedSelectChild(child)) return false;
  }
  return true;
}

function hasImportFromSearchableSelect(sourceFile) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    const moduleText = statement.moduleSpecifier.getText(sourceFile).slice(1, -1);
    return moduleText === IMPORT_PATH;
  });
}

function getImportInsertPos(sourceFile, sourceText) {
  let insertPos = 0;
  for (const statement of sourceFile.statements) {
    const isClientDirective =
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === "use client";
    if (ts.isImportDeclaration(statement) || isClientDirective) {
      insertPos = statement.end;
      continue;
    }
    break;
  }

  if (insertPos === 0) {
    return 0;
  }

  const after = sourceText[insertPos];
  if (after === "\r" || after === "\n") return insertPos;
  return insertPos;
}

function addSearchableSelectImport(sourceText, sourceFile) {
  if (hasImportFromSearchableSelect(sourceFile)) return sourceText;

  const insertPos = getImportInsertPos(sourceFile, sourceText);
  const needsLeadingNewline = sourceText[insertPos] !== "\n" && sourceText[insertPos] !== "\r" ? "\n" : "";
  return `${sourceText.slice(0, insertPos)}${needsLeadingNewline}${IMPORT_LINE}\n${sourceText.slice(insertPos)}`;
}

function processFile(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const replacements = [];
  const fileStats = {
    file: path.relative(ROOT_DIR, filePath),
    totalSelects: 0,
    convertedSelects: 0,
    skipped: {
      multiple: 0,
      unsupportedChildren: 0,
      other: 0,
    },
    notes: [],
  };

  function visit(node) {
    if (ts.isJsxSelfClosingElement(node)) {
      const tagName = getSelectNodeName(node.tagName);
      if (tagName === "select") {
        fileStats.totalSelects += 1;
        report.totalSelects += 1;
        fileStats.skipped.other += 1;
        fileStats.notes.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          reason: "self_closing",
        });
        report.totalSkipped += 1;
      }
    }

    if (ts.isJsxElement(node)) {
      const tagName = getSelectNodeName(node.openingElement.tagName);
      if (tagName === "select") {
        fileStats.totalSelects += 1;
        report.totalSelects += 1;
        const multiple = hasMultipleAttribute(node.openingElement.attributes);
        if (multiple) {
          fileStats.skipped.multiple += 1;
          fileStats.notes.push({
            line: sourceFile.getLineAndCharacterOfPosition(node.openingElement.getStart()).line + 1,
            reason: "multiple",
          });
          report.totalSkipped += 1;
          ts.forEachChild(node, visit);
          return;
        }

        if (!isOptionBasedSelect(node.openingElement, node.children)) {
          fileStats.skipped.unsupportedChildren += 1;
          fileStats.notes.push({
            line: sourceFile.getLineAndCharacterOfPosition(node.openingElement.getStart()).line + 1,
            reason: "unsupported_children",
          });
          report.totalSkipped += 1;
          ts.forEachChild(node, visit);
          return;
        }

        const openStart = node.openingElement.getStart();
        const openEnd = node.openingElement.getEnd();
        const closeStart = node.closingElement.getStart();
        const closeEnd = node.closingElement.getEnd();
        const openText = sourceText.slice(openStart, openEnd).replace(/^<select\b/, "<SearchableSelect");
        const closeText = sourceText.slice(closeStart, closeEnd).replace(/^<\/select>/, "</SearchableSelect>");

        replacements.push({ start: openStart, end: openEnd, replacement: openText });
        replacements.push({ start: closeStart, end: closeEnd, replacement: closeText });
        fileStats.convertedSelects += 1;
        report.totalConverted += 1;
        ts.forEachChild(node, visit);
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  let updatedText = sourceText;
  if (replacements.length > 0) {
    const uniqueReplacements = replacements.sort((a, b) => b.start - a.start);
    for (const replacement of uniqueReplacements) {
      updatedText = `${updatedText.slice(0, replacement.start)}${replacement.replacement}${updatedText.slice(replacement.end)}`;
    }

    const updatedSource = ts.createSourceFile(filePath, updatedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    updatedText = addSearchableSelectImport(updatedText, updatedSource);
  }

  if (updatedText !== sourceText) {
    fs.writeFileSync(filePath, updatedText, "utf8");
  }

  report.files.push(fileStats);
}

const files = collectComponentFiles(COMPONENTS_DIR);
report.totalFilesScanned = files.length;

for (const file of files) {
  processFile(file);
}

fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Scanned ${report.totalFilesScanned} files`);
console.log(`Found ${report.totalSelects} <select> nodes`);
console.log(`Converted ${report.totalConverted} to <SearchableSelect>`);
console.log(`Skipped ${report.totalSkipped} for review`);
console.log(`Report saved: ${REPORT_PATH}`);
