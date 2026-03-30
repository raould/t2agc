# Agents

Read: t2lang/STYLE_GUIDE.md

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
[{ kind: "file", path: "a.ts" },
 { kind: "rule", name: "build-grammar" }]

;; AVOID
(array 1 2 3)
```

### Import syntax: `{ name1 name2 }` for named imports

With commas.

```lisp
(import { readdirSync, writeFileSync, renameSync } "node:fs")
(import path "node:path")
```

### Type annotations everywhere

Annotate all bindings and parameters. No space before the ":", one space after.

```lisp
(const (stage9Dir: string) (path.join ctx.projectRoot "stage9"))
(const (items: (type-array string)) [])
(fn ((ctx: BuildContext)) ...)
(async-fn ((filePath: string) (input: string)) ...)
```

| t2 syntax | TypeScript output |
|---|---|
| `(x: string)` | `x: string` |
| `(x: number)` | `x: number` |
| `(x: boolean)` | `x: boolean` |
| `(x: any)` | `x: any` |
| `(x: (type-array string))` | `x: string[]` |
| `(x: (or string null))` | `x: string \| null` |

### Properties

prefer the more consise form
`(jsObjInstance.propertyName)`
over
`(. jsObjInstance propertyName)`

### Invoking callables

prefer the more concise form
`(jsObjInstance.functionName arg1 arg2)`
over
`((. jsObjInstance functionName) arg1 arg2)`

prefer the more concise form
`(objectInstance.methodName methodArg1 methodArg2)`
over
`(method-call objectInstance methodName methodArg1 methodArg2)`

### Non-void callable statements must explicitly return values

There are no implicit returns.

- `(lambda ((x)) x)` returns undefined, so this form is only useful when the callable is being used only for side-effects e.g. logging to console, or mutating the argument.

- `(lambda ((x)) (return x))` returns the passed-in value.

### Sample

```lisp
(shk.rule {
  name: "build-compiler",
  output: "stage9/index.ts",
  deps: [{ kind: "rule", name: "build-grammar" },
         { kind: "glob", pattern: "stage9/Stage9*.s8" },
         { kind: "file", path: "stage9/Stage9-tags.ts" }],
  action: (async-fn ((ctx: any))
    (const (stage9Dir: string) (path.join ctx.projectRoot "stage9"))
    (const (files: (type-array string))
      ((readdirSync stage9Dir).filter (fn ((f: string)) (return (f.endsWith ".s8")))))
    (for-of f files
      (const (result: any) (await (ctx.run tsxBin [compilerPath srcPath])))
      (writeFileSync tmpPath result.stdout)))
  }
)
```

## Testing

- Framework: Vitest (with `--typecheck`)
- Always run vitest with `--typecheck`.
- Always run vitest via run, as `npx vitest --typecheck run`, never bare `vitest run`.

## Security

- Never commit secrets or credentials

## General Notes

- Use commas in object or array literals.
- Object literal keys are bare identifiers (no quotes required for simple keys).
- Literal forms `{ ... }` vs. `(obj ...)`, `[ ... ]` vs. `(array ...)` compile to identical JavaScript, so prefer the literal forms.
