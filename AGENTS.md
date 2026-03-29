# t2lang

A bootstrapping compiler chain (stage3 → ... → stage9) that compiles s-expression source files (`.s8`, `.s7`, `.s6`, `.s5`) to TypeScript.

## Project Structure

- `stage9/` — current compiler stage (`.s8` sources → `.ts` outputs)
- `stage8/` — previous stage compiler (used to build stage9)
- `stage9/Stage9*.s8` — compiler source files (edit these, not the `.ts` outputs)
- `stage9/Stage9-tags.ts`, `Stage9-debug.ts`, `Stage9-parse-form.ts` — hand-authored TypeScript (not compiled)
- `stage9/index.ts` — compiled from `Stage9.s8` (main entry point)
- `stage9/tests/` — test suite (Vitest)
- `bin/t2tc.js`, `bin/t2jc.js`, `bin/t2run.js` — CLI wrappers
- `index.ts` — root re-export: `export { compile } from "./stage9/index.ts"`
- `build.shk` — MiniShake build file

## Build & Commands

```sh
# Install all stage dependencies
npm run modules

# Build the compiler (compile all .s8 → .ts)
npm run build            # or: shk build build-compiler

# Run tests (includes build)
npm test

# Run tests only (no rebuild)
npm run testnow

# Run tests directly
cd stage9 && npx vitest --typecheck run
```

Always run vitest as `npx vitest --typecheck run` — never bare `vitest run`.

## Architecture

- **Programmatic API only:** `compile()` is the sole public API — never process `argv` in compiler source
- **CLI wrappers** (`bin/t2*.js`) are the only place that parses command-line arguments; they convert flags to `compile()` config
- **Import:** `import { compile } from "t2lang"`
- **Source → output mapping:** `Stage9-foo.s8` → `Stage9-foo.ts`; exception: `Stage9.s8` → `index.ts`
- **Never edit `.ts` files** that are compiled from `.s8` sources — they get overwritten on build

## Code Style & Conventions

Source files use t2 s-expression syntax that compiles to TypeScript. Prefer the concise literal forms over verbose s-expression forms.

### Object literals: `{ ... }` not `(object ...)`

Bare keys, colon separators, with commas between entries.

```lisp
;; PREFERRED
{ kind: "file", path: "stage9/Stage9.g4" }

;; AVOID
(object (kind "file") (path "stage9/Stage9.g4"))
```

Nested:

```lisp
{ name: "build-grammar",
  output: "stage9/Stage9Lexer.ts",
  deps: [{ kind: "file", path: "stage9/Stage9.g4" }] }
```

### Array literals: `[ ... ]` not `(array ...)`

Square brackets, with commas between elements.

```lisp
;; PREFERRED
[1, 2, 3]
["hello", "world"]
[{ kind: "file", path: "a.ts" }
 { kind: "rule", name: "build-grammar" }]

;; AVOID
(array 1 2 3)
```

### Import syntax: `{ name1 name2 }` for named imports

```lisp
(import { readdirSync writeFileSync renameSync } "node:fs")
(import path "node:path")
```

### Type annotations everywhere

Annotate all bindings and parameters.

```lisp
(const (stage9Dir : string) ((. path join) (. ctx projectRoot) "stage9"))
(const (items : (type-array string)) [])
(fn ((ctx : BuildContext)) ...)
(async-fn ((filePath : string) (input : string)) ...)
```

| t2 syntax | TypeScript output |
|---|---|
| `(x : string)` | `x: string` |
| `(x : number)` | `x: number` |
| `(x : boolean)` | `x: boolean` |
| `(x : any)` | `x: any` |
| `(x : (type-array string))` | `x: string[]` |
| `(x : (or string null))` | `x: string \| null` |

### Complete example

```lisp
((. shk rule) {
  name: "build-compiler"
  output: "stage9/index.ts"
  deps: [{ kind: "rule" name: "build-grammar" }
         { kind: "glob" pattern: "stage9/Stage9*.s8" }
         { kind: "file" path: "stage9/Stage9-tags.ts" }]
  action: (async-fn ((ctx : any))
    (const (stage9Dir : string) ((. path join) (. ctx projectRoot) "stage9"))
    (const (files : (type-array string))
      ((. (readdirSync stage9Dir) filter) (fn ((f : string)) (return ((. f endsWith) ".s8")))))
    (for-of f files
      (const (result : any) (await ((. ctx run) tsxBin [compilerPath srcPath])))
      (writeFileSync tmpPath (. result stdout))))})
```

## Testing

- Framework: Vitest (with `--typecheck`)
- Tests live in `stage9/tests/`
- Tests call `compile()` programmatically — no subprocess spawning
- Helper pattern:
  ```typescript
  import { compile } from '../index';
  const result = compile({ filePath: '-', input: t2Source });
  ```

## Security

- Never commit secrets or credentials
- CLI wrappers validate and sanitize user input before passing to `compile()`
- `compile()` operates on file contents only — no shell execution

## General Notes

- Use commas in object or array literals.
- Object literal keys are bare identifiers (no quotes for simple keys)
- Literal forms compile to identical JavaScript as verbose counterparts
- Paren balance is critical — verify with a depth-checking script before committing `.s8` changes
