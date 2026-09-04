/* global console */

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const sourceExtensions = Object.freeze([".ts", ".tsx", ".mts", ".cts"]);
const layerRoots = Object.freeze([
  "apps",
  "packages/domain",
  "packages/integrations",
  "packages/observability",
]);

const allowedDependencies = Object.freeze({
  apps: Object.freeze([
    "apps",
    "packages/domain",
    "packages/integrations",
    "packages/observability",
  ]),
  "packages/domain": Object.freeze(["packages/domain"]),
  "packages/integrations": Object.freeze([
    "packages/domain",
    "packages/integrations",
  ]),
  "packages/observability": Object.freeze([
    "packages/domain",
    "packages/observability",
  ]),
});

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function findLayer(repositoryRelativePath) {
  const normalizedPath = toPosixPath(repositoryRelativePath);

  return layerRoots.find(
    (layerRoot) =>
      normalizedPath === layerRoot ||
      normalizedPath.startsWith(`${layerRoot}/`),
  );
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return collectSourceFiles(entryPath);
      }

      return sourceExtensions.some((extension) =>
        entry.name.endsWith(extension),
      )
        ? [entryPath]
        : [];
    }),
  );

  return nestedFiles.flat();
}

function collectModuleSpecifiers(sourceText, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const moduleSpecifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      moduleSpecifiers.push(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      moduleSpecifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return moduleSpecifiers;
}

function describeViolation(repositoryRoot, importerPath, moduleSpecifier) {
  const importerRelativePath = relative(repositoryRoot, importerPath);
  const importerLayer = findLayer(importerRelativePath);

  if (!importerLayer) {
    return undefined;
  }

  if (!moduleSpecifier.startsWith(".")) {
    return importerLayer === "packages/domain"
      ? `${toPosixPath(importerRelativePath)}: domain code cannot import external module "${moduleSpecifier}"`
      : undefined;
  }

  const dependencyPath = resolve(dirname(importerPath), moduleSpecifier);
  const dependencyLayer = findLayer(relative(repositoryRoot, dependencyPath));

  if (
    !dependencyLayer ||
    allowedDependencies[importerLayer].includes(dependencyLayer)
  ) {
    return undefined;
  }

  return `${toPosixPath(importerRelativePath)}: ${importerLayer} cannot depend on ${dependencyLayer} via "${moduleSpecifier}"`;
}

export async function checkArchitecture(repositoryRoot) {
  const sourceDirectories = await Promise.all(
    layerRoots.map(async (layerRoot) => {
      try {
        return await collectSourceFiles(resolve(repositoryRoot, layerRoot));
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }

        throw error;
      }
    }),
  );
  const sourceFiles = sourceDirectories.flat();
  const violations = [];

  for (const sourcePath of sourceFiles) {
    const sourceText = await readFile(sourcePath, "utf8");

    for (const moduleSpecifier of collectModuleSpecifiers(
      sourceText,
      sourcePath,
    )) {
      const violation = describeViolation(
        repositoryRoot,
        sourcePath,
        moduleSpecifier,
      );

      if (violation) {
        violations.push(violation);
      }
    }
  }

  return violations;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await checkArchitecture(repositoryRoot);

  if (violations.length > 0) {
    console.error("Architecture dependency violations found:");
    violations.forEach((violation) => console.error(`- ${violation}`));
    process.exitCode = 1;
  } else {
    console.log("Architecture dependency check passed.");
  }
}
