/**
 * Test helpers for t2agc — adapted from node_modules/t2lang/stage9/tests/helpers.ts.
 *
 * `fromSourceEndToEnd(t2Source)` compiles a self-contained t2 program string:
 *   1. Compiles it to TypeScript via `npx t2tc --stdout -` (reads from stdin).
 *   2. Transpiles the TypeScript to CommonJS JavaScript using the TypeScript API.
 *   3. Executes the JavaScript in a Node.js vm sandbox.
 *
 * Use `asrt(actual, expected)` and `asrtDeep(actual, expected)` inside your
 * inline t2 programs.  Import them at the top of each program:
 *
 *   (import (object (named (array (object (name "asrt")) (object (name "asrtDeep"))))) "./helpers.js")
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import vm from 'vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── simple assertion helpers ──────────────────────────────────────────────────

export function asrt(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`asrt failed: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

export function asrtDeep(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `asrtDeep failed:\n  got:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

export function prefixLineNumbers(str: string): string {
  return str
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, '0')}: ${line}`)
    .join('\n');
}

export function loadSrc(filename: string): string {
  const filePath = path.join(__dirname, '../src', filename);
  const content = readFileSync(filePath, 'utf-8');
  
  // Try to remove outer (program ...) wrapper if present
  // This is a naive regex but works for the current codebase style
  const match = content.match(/^\s*\(program\s+([\s\S]*)\)\s*$/);
  if (match) {
    return match[1];
  }
  return content;
}

// ── step 1: compile .t2 source string → TypeScript ───────────────────────────

function compileT2(t2Source: string): string {
  const res = spawnSync('npx', ['t2tc', '--stdout', '-', '--outDir dist'], {
    encoding: 'utf-8',
    input: t2Source,
    cwd: path.resolve(__dirname, '..'),
  });
  if (res.status !== 0 || (res.stderr && res.stderr.trim() !== '')) {
    console.error(prefixLineNumbers(t2Source));
    console.error(res.stderr);
    throw new Error(`t2 compilation failed:\n${res.stderr}`);
  }
  return res.stdout as string;
}

// ── step 2: transpile TypeScript → CommonJS JavaScript ───────────────────────

function transpileTs(tsCode: string): string {
  const syntheticFileName = path.join(__dirname, '__generated__.ts');

  const defaultHost = ts.createCompilerHost({});
  const customHost: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (fileName, languageVersion) => {
      if (fileName === syntheticFileName)
        return ts.createSourceFile(fileName, tsCode, languageVersion, true);
      return defaultHost.getSourceFile(fileName, languageVersion);
    },
    writeFile: () => {},
    fileExists: (fileName) =>
      fileName === syntheticFileName || defaultHost.fileExists(fileName),
    readFile: (fileName) =>
      fileName === syntheticFileName ? tsCode : defaultHost.readFile(fileName),
  };

  const program = ts.createProgram([syntheticFileName], {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    strict: false,
    noImplicitAny: false,
    lib: ['lib.es2020.d.ts'],
  }, customHost);

  const sourceFile = program.getSourceFile(syntheticFileName)!;
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];

  if (diagnostics.length > 0) {
    console.error(prefixLineNumbers(tsCode));
    const msg = diagnostics
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new Error(`TypeScript errors:\n${msg}`);
  }

  let outputText = '';
  program.emit(sourceFile, (_fileName, text) => {
    outputText = text;
  });
  return outputText;
}

// ── step 3: run CommonJS JavaScript in a vm sandbox ──────────────────────────

function runJs(js: string): void {
  const helperExports = { asrt, asrtDeep };
  const mod = { exports: {} as Record<string, unknown> };
  const sandbox = {
    console,
    module: mod,
    exports: mod.exports,
    require: (id: string) => {
      if (id === './helpers' || id.endsWith('/helpers') || id.endsWith('/helpers.js'))
        return helperExports;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).require?.(id);
    },
    globalThis,
    crypto,
  };
  try {
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox, { filename: 'test.generated.js' });
  } catch (e) {
    console.error(prefixLineNumbers(js));
    throw new Error(`execution error: ${e}`);
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/** Compile and run a self-contained t2 program string end-to-end. */
export function fromSourceEndToEnd(t2Source: string): void {
  const tsCode = compileT2(t2Source);
  const jsCode = transpileTs(tsCode);
  runJs(jsCode);
}

/** Read a .t2 file and run it end-to-end (path relative to tests/). */
export function fromFileEndToEnd(t2File: string): void {
  const t2Path = path.join(__dirname, t2File);
  const t2Source = readFileSync(t2Path, 'utf-8');
  fromSourceEndToEnd(t2Source);
}
