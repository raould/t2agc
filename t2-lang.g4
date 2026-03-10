grammar Stage7;

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// important note: maintain `propKey`, see below.
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// ─────────────────────────────────────────────
// Parser rules
// ─────────────────────────────────────────────

program
    : LPAREN PROGRAM topLevel* RPAREN
    ;

topLevel
    : defmacro
    | macroTimeFnDef
    | topLevelLet
    | topLevelConst
    | typeAlias
    | interfaceDef
    | classDef
    | exportDeclForm
    | statement
    ;

// ─── top-level forms ─────────────────────────
// i remain confused as to why these exist yet.

// Named group for inline-exportable declarations.
// anonClassDef is NOT included — only reachable from exportDefaultDecl (Phase 3).
decl
    : topLevelLet
    | topLevelConst
    | classDef
    | interfaceDef
    | typeAlias
    ;

defmacro
    : LPAREN DEFMACRO IDENTIFIER fnSignature statement* RPAREN
    ;

macroTimeFnDef
    : LPAREN MACRO_TIME_ATTR topLevelLet  RPAREN
    | LPAREN MACRO_TIME_ATTR topLevelConst RPAREN
    ;

topLevelLet
    : LPAREN LET metaAnnotation* IDENTIFIER expression RPAREN
    ;

topLevelConst
    : LPAREN CONST metaAnnotation* IDENTIFIER expression RPAREN
    ;

// metadata annotation: ^:keyword  (e.g. ^:pure, ^:async)
metaAnnotation
    : CARET KEYWORD
    ;

typeAlias
    : LPAREN TYPE IDENTIFIER typeParams? typeExpr RPAREN
    ;

interfaceDef
    : LPAREN INTERFACE IDENTIFIER typeParams? interfaceExtends? typeObject RPAREN
    ;

interfaceExtends
    : LPAREN EXTENDS typeExpr+ RPAREN
    ;

// ─── class system ─────────────────────────────

classDef
    : LPAREN CLASS modifier* IDENTIFIER typeParams? classExtends? classImplements? classBody RPAREN
    ;

// Anonymous class — no name, no typeParams.
anonClassDef
    : LPAREN CLASS modifier* classExtends? classImplements? classBody RPAREN
    ;

classExtends
    : LPAREN EXTENDS typeExpr RPAREN
    ;

classImplements
    : LPAREN IMPLEMENTS typeExpr+ RPAREN
    ;

classBody
    : LPAREN CLASS_BODY classElement* RPAREN
    ;

classElement
    : fieldDef
    | constructorDef
    | classMethodDef
    | abstractMethodDef
    | getterDef
    | setterDef
    ;

modifier
    : KEYWORD
    ;

fieldDef
    : LPAREN FIELD modifier* IDENTIFIER (COLON typeExpr)? expression? RPAREN
    ;

constructorDef
    : LPAREN CONSTRUCTOR fnSignatureTyped statement* RPAREN
    ;

classMethodDef
    : LPAREN METHOD modifier* methodKey fnSignatureTyped statement* RPAREN
    ;

abstractMethodDef
    : LPAREN ABSTRACT_METHOD modifier* methodKey fnSignatureTyped RPAREN
    ;

getterDef
    : LPAREN GET modifier* methodKey fnSignatureTyped statement* RPAREN
    ;

setterDef
    : LPAREN SETPROP modifier* methodKey fnSignatureTyped statement* RPAREN
    ;

methodKey
    : IDENTIFIER
    | LBRACK expression RBRACK
    ;

typedParam
    : LPAREN IDENTIFIER OPTIONAL? (COLON typeExpr)? RPAREN
    ;

fnSignatureTyped
    : LPAREN (typedParam (COMMA? typedParam)*)? RPAREN (LPAREN RETURNS typeExpr RPAREN)?
    ;

// ─── statements ──────────────────────────────

statement
    : letStar
    | letStmt
    | constStar
    | constStmt
    | ifForm
    | whileForm
    | tryForm
    | block
    | returnForm
    | throwForm
    | importForm
    | importTypeForm
    | exportForm
    | switchForm
    | forForm
    | forInForm
    | forOfForm
    | forAwaitForm
    | assign
    | expression
    ;


letStar
    : LPAREN LETSTAR LPAREN starBinding* RPAREN statement* RPAREN
    ;

letStmt
    : LPAREN LET singleBinding expression RPAREN
    ;

constStar
    : LPAREN CONSTSTAR LPAREN starBinding* RPAREN statement* RPAREN
    ;

constStmt
    : LPAREN CONST singleBinding expression RPAREN
    ;

ifForm
    : LPAREN IF expression statement statement? RPAREN
    ;

whileForm
    : LPAREN WHILE expression statement* RPAREN
    ;

block
    : LPAREN BEGIN statement* RPAREN
    ;

returnForm
    : LPAREN RETURN expression? RPAREN
    ;

throwForm
    : LPAREN THROW expression RPAREN
    ;

importForm
    : LPAREN IMPORT objectExpr? STRING RPAREN
    ;

// (import-type (named Foo Bar) "./mod")  → import type { Foo, Bar } from "./mod";
// (import-type (named (Foo F)) "./mod")  → import type { Foo as F } from "./mod";
importTypeForm
    : LPAREN IMPORT_TYPE importTypeSpec STRING RPAREN
    ;

importTypeSpec
    : LPAREN IDENTIFIER importTypeName+ RPAREN
    ;

importTypeName
    : IDENTIFIER
    | LPAREN IDENTIFIER IDENTIFIER RPAREN
    ;

// -----------------------------
// Export Forms
// -----------------------------

exportForm
    : exportBinding
    | exportDefault
    | exportNamed
    | exportNsFromForm
    | exportFrom
    | exportAllFrom
    | exportTypeForm
    | exportTypeFromForm
    | exportTypeAllFromForm
    ;

// (export name value)
exportBinding
    : LPAREN EXPORT IDENTIFIER expression RPAREN
    ;

// (export-default value)
// Also accepts inline declaration forms for: export default class Foo { }
//                                            export default class { }
//                                            export default function foo() { }
exportDefault
    : LPAREN EXPORT_DEFAULT classDef RPAREN
    | LPAREN EXPORT_DEFAULT anonClassDef RPAREN
    | LPAREN EXPORT_DEFAULT topLevelLet RPAREN
    | LPAREN EXPORT_DEFAULT topLevelConst RPAREN
    | LPAREN EXPORT_DEFAULT expression RPAREN
    ;

// (export-named (name alias?) ...)
exportNamed
    : LPAREN EXPORT_NAMED exportNamePair+ RPAREN
    ;

exportNamePair
    : LPAREN IDENTIFIER (IDENTIFIER)? RPAREN
    ;
// (x)        → export x
// (y z)      → export y as z

// (export-from "module" (name alias?) ...)
exportFrom
    : LPAREN EXPORT_FROM STRING exportNamePair+ RPAREN
    ;

// (export-all-from "module")
exportAllFrom
    : LPAREN EXPORT_ALL_FROM STRING RPAREN
    ;

// (export-ns-from "ns" "module")  → export * as ns from "module";
exportNsFromForm
    : LPAREN EXPORT_NS_FROM STRING STRING RPAREN
    ;

// (export-type (Name) (Name Alias) ...)
exportTypeForm
    : LPAREN EXPORT_TYPE exportNamePair+ RPAREN
    ;

// (export-type-from "./mod" (Name) ...)
exportTypeFromForm
    : LPAREN EXPORT_TYPE_FROM STRING exportNamePair+ RPAREN
    ;

// (export-type-all-from "./mod")
exportTypeAllFromForm
    : LPAREN EXPORT_TYPE_ALL_FROM STRING RPAREN
    ;

// (export (def ...)) | (export (class ...)) | (export (interface ...)) | (export (type ...))
// Hooked into topLevel, not exportForm.
// Disambiguated from exportBinding by second token after EXPORT: LPAREN (decl) vs IDENTIFIER.
exportDeclForm
    : LPAREN EXPORT decl RPAREN
    ;

// ──── some bindings ──────────────────────

starBinding
    : LPAREN IDENTIFIER (COLON typeExpr)? expression RPAREN
    ;

singleBinding
    : LPAREN IDENTIFIER (COLON typeExpr)? RPAREN
    ;

// ─── type expressions ────────────────────────

typeExpr
    : IDENTIFIER
    | typeUnion
    | typeIntersection
    | typeArray
    | typeTuple
    | typeFunction
    | typeObject
    | typeLiteral
    | typeKeyof
    | typeTypeof
    | typeIndexAccess
    | typeConditional
    | typeInfer
    | typeMapped
    | typeTemplateLiteral
    | typeApplication
    ;

typeUnion
    : LPAREN UNION typeExpr typeExpr+ RPAREN
    ;

typeIntersection
    : LPAREN INTERSECT typeExpr typeExpr+ RPAREN
    ;

typeArray
    : LPAREN TYPE_ARRAY typeExpr RPAREN
    ;

typeTuple
    : LPAREN TUPLE typeTupleElement+ RPAREN
    ;

typeTupleElement
    : LPAREN REST typeExpr RPAREN
    | LPAREN IDENTIFIER typeExpr RPAREN
    | typeExpr
    ;

typeFunction
    : LPAREN TYPEFN typeParams? LPAREN typeFnParam* RPAREN typeExpr RPAREN
    ;

typeFnParam
    : LPAREN IDENTIFIER OPTIONAL? typeExpr RPAREN
    ;

typeObject // theoretically will not collide too much with other value-level syntax?
    : LPAREN IDENTIFIER typeProp* RPAREN
    ;

typeProp
    : LPAREN propModifier* IDENTIFIER OPTIONAL? typeExpr RPAREN
    ;

propModifier
    : READONLY
    ;

typeLiteral
    : LPAREN LIT (STRING | NUMBER | BOOLEAN) RPAREN
    ;

typeKeyof
    : LPAREN KEYOF typeExpr RPAREN
    ;

typeTypeof
    : LPAREN TYPEOF IDENTIFIER RPAREN
    ;

typeIndexAccess
    : LPAREN INDEX typeExpr typeExpr RPAREN
    ;

typeConditional
    : LPAREN COND typeExpr typeExpr typeExpr typeExpr RPAREN
    ;

typeInfer
    : LPAREN INFER IDENTIFIER RPAREN
    ;

typeMapped
    : LPAREN MAPPED IDENTIFIER typeExpr mappedModifiers? typeExpr RPAREN
    ;

mappedModifiers
    : LPAREN MODIFIERS mappedModifier+ RPAREN
    ;

mappedModifier
    : READONLY | OPTIONAL
    ;

typeTemplateLiteral
    : LPAREN TYPE_TEMPLATE templatePart+ RPAREN
    ;

templatePart
    : STRING
    | typeExpr
    ;

typeApplication
    : LPAREN typeExpr typeExpr+ RPAREN
    ;

typeParams
    : LPAREN TYPE_PARAMS typeParamDecl+ RPAREN
    ;

typeParamDecl
    : IDENTIFIER
    | LPAREN IDENTIFIER typeParamConstraint? typeParamDefault? RPAREN
    ;

typeParamConstraint
    : LPAREN EXTENDS typeExpr RPAREN
    ;

typeParamDefault
    : LPAREN DEFAULT typeExpr RPAREN
    ;

assign
    : LPAREN SET IDENTIFIER expression RPAREN
    | LPAREN SET propAccess expression RPAREN
    ;

switchForm
    : LPAREN SWITCH expression caseClause* defaultClause? RPAREN
    ;

caseClause
    : LPAREN CASE expression statement* RPAREN
    ;

defaultClause
    : LPAREN DEFAULT statement* RPAREN
    ;

forForm
    : LPAREN FOR letStmt expression assign statement* RPAREN
    ;

forInForm
    : LPAREN FORIN IDENTIFIER expression statement* RPAREN
    ;

forOfForm
    : LPAREN FOROF IDENTIFIER expression statement* RPAREN
    ;

forAwaitForm
    : LPAREN FORAWAIT IDENTIFIER expression statement* RPAREN
    ;

tryForm
    : LPAREN TRY statement* (catchClause finallyClause? | finallyClause) RPAREN
    ;

catchClause
    : LPAREN CATCH IDENTIFIER statement* RPAREN
    ;

finallyClause
    : LPAREN FINALLY statement* RPAREN
    ;

// ─── expressions ─────────────────────────────

expression
    : literal
    | KEYWORD
    | IDENTIFIER
    | lambda
    | fn
    | asyncLambda
    | asyncFn
    | generatorFn
    | asyncGeneratorFn
    | awaitExpr
    | yieldExpr
    | yieldStarExpr
    | bindExpr
    | methodCallExpr
    | objectExpr
    | arrayExpr
    | propAccess
    | indexAccess
    | quasiquote
    | unquote
    | unquoteSplicing
    | ternary
    | condExpr
    | newForm
    | optChain
    | optChainIndex
    | nullCoalesce
    | typeofExpr
    | typeAssert
    | templateExpr
    | thisExpr
    | superExpr
    | superConstructorCall
    | superMethodCall
    | call // if no previous form matches, assume callable.
    ;

thisExpr
    : THIS
    ;

superExpr
    : SUPER
    ;

superConstructorCall
    : LPAREN SUPER expression* RPAREN
    ;

superMethodCall
    : LPAREN SUPER_METHOD IDENTIFIER expression* RPAREN
    ;

typeofExpr
    : LPAREN TYPEOF expression RPAREN
    ;

typeAssert
    : LPAREN TYPE_AS expression typeExpr RPAREN
    ;

lambda
    : LPAREN LAMBDA fnSignature statement* RPAREN
    ;

fn
    : LPAREN FN fnSignature statement* RPAREN
    ;

asyncLambda
    : LPAREN ASYNC_LAMBDA fnSignature statement* RPAREN
    ;

asyncFn
    : LPAREN ASYNC_FN fnSignature statement* RPAREN
    ;

generatorFn
    : LPAREN GENERATOR_FN fnSignature statement* RPAREN
    ;

asyncGeneratorFn
    : LPAREN ASYNC_GENERATOR_FN fnSignature statement* RPAREN
    ;

awaitExpr
    : LPAREN AWAIT expression RPAREN
    ;

yieldExpr
    : LPAREN YIELD expression? RPAREN
    ;

yieldStarExpr
    : LPAREN YIELD_STAR expression RPAREN
    ;

bindExpr
    : LPAREN BIND expression expression expression* RPAREN
    ;

methodCallExpr
    : LPAREN METHOD_CALL expression expression expression* RPAREN
    ;

ternary
    : LPAREN TERNARY expression expression expression RPAREN
    ;

condExpr
    : LPAREN COND (expression expression)+ RPAREN
    ;

newForm
    : LPAREN NEW IDENTIFIER typeArgs? expression* RPAREN
    ;

// ─── data literals ───────────────────────────

objectExpr
    : LPAREN OBJECT objectField* RPAREN
    ;

objectField
    : LPAREN propKey expression RPAREN
    | LPAREN propKey methodDef RPAREN
    | LPAREN IDENTIFIER RPAREN
    ;

methodDef
    : LPAREN METHOD fnSignature statement* RPAREN
    ;

arrayExpr
    : LPAREN ARRAY expression* RPAREN
    ;

// Value-level template literal: emitted by the reader from `hello ${name}`
// Alternates: STRING chunks and expression holes, always starting and ending with STRING.
templateExpr
    : LPAREN TEMPLATE (STRING | expression)+ RPAREN
    ;

// ─── property / index access ─────────────────

// propKey: any token that can appear as a property name.
// Enumerating all keywords here lets callers write (. obj lambda)
// instead of (. obj "lambda") for keyword-named properties.
// !! IMPORTANT FOR AI AGENTS !!
// When you add a new keyword token to the lexer, you MUST also add it
// to the propKey rule below, or property access using that name will
// silently fall back to the STRING alternative and require quoting.
// Example: adding `FOO : 'foo' ;` → also add `| FOO` here.
propKey
    : IDENTIFIER
    | KEYWORD
    | STRING
    | NUMBER
    | PROGRAM | LETSTAR | LET | CONSTSTAR | CONST | LAMBDA | FN | METHOD | BIND | METHOD_CALL
    | DEFMACRO | MACRO_TIME_ATTR | IF | WHILE | BEGIN | RETURN | THROW | SET | TERNARY | COND
    | OBJECT | ARRAY | INDEX | QUASI | QUOTE | UNQUOTE_SPLICING | UNQUOTE
    | TYPE_ARRAY
    | NEW | IMPORT | SWITCH | CASE | DEFAULT | FORIN | FOROF | FOR
    | FORAWAIT | TRY | CATCH | FINALLY
    | UNION | INTERSECT | TUPLE | TYPEFN | LIT | KEYOF | TYPEOF | INFER | MAPPED | TYPE_TEMPLATE
    | TEMPLATE
    | REST | READONLY | TYPE_AS | TYPE_PARAMS | TYPE_ARGS | EXTENDS | RETURNS | TYPE | INTERFACE | MODIFIERS
    | BOOLEAN | NULL | UNDEFINED
    | EXPORT | EXPORT_DEFAULT | EXPORT_NAMED | EXPORT_NS_FROM | EXPORT_FROM | EXPORT_ALL_FROM
    | IMPORT_TYPE | EXPORT_TYPE | EXPORT_TYPE_FROM | EXPORT_TYPE_ALL_FROM
    | CLASS | CLASS_BODY | FIELD | CONSTRUCTOR | THIS | SUPER | SUPER_METHOD
    | GET | SETPROP | ABSTRACT_METHOD | IMPLEMENTS
    | ASYNC_GENERATOR_FN | ASYNC_LAMBDA | ASYNC_FN | GENERATOR_FN
    | YIELD_STAR | YIELD | AWAIT | CARET
    ;

propAccess
    : LPAREN DOT expression propKey RPAREN
    ;

indexAccess
    : LPAREN INDEX expression expression RPAREN
    ;

// ─── quasiquote ──────────────────────────────

quasiquote
    : LPAREN (QUASI | QUOTE) quasiForm RPAREN
    ;

quasiForm
    : expression
    | topLevelLet
    | topLevelConst
    | typeAlias
    | interfaceDef
    | classDef
    | importForm
    ;

unquote
    : LPAREN UNQUOTE expression RPAREN
    ;

unquoteSplicing
    : LPAREN UNQUOTE_SPLICING expression RPAREN
    ;

// ─── optional chaining / null coalescing ─────

optChain
    : LPAREN OPTCHAIN expression propKey RPAREN
    ;

// Optional index access: foo?.[expr] → (optchain-index foo expr)
// Kept separate from optChain for the same reason indexAccess is separate from propAccess.
optChainIndex
    : LPAREN OPTCHAIN_INDEX expression expression RPAREN
    ;

nullCoalesce
    : LPAREN NULLCOAL expression expression RPAREN
    ;

// ─── call ────────────────────────────────────

// syntax for function invocation; optional type arguments may
// appear immediately after the callee.  typeArgs is a separate
// rule so that `(type-args ...)` doesn't accidentally parse as a
// normal call expression.
call
    : LPAREN expression typeArgs? expression* RPAREN
    ;

// a list of type expressions appearing at call sites or `new` forms
// (see docs/TYPE_DESIGN.md for examples)
typeArgs
    : LPAREN TYPE_ARGS typeExpr+ RPAREN
    ;

// ─── shared ──────────────────────────────────

fnSignature
    : LPAREN (param (COMMA? param)* (COMMA? restParam)?)? RPAREN (COLON typeExpr)?
    | LPAREN restParam RPAREN (COLON typeExpr)?
    ;

param
    : LPAREN IDENTIFIER (COLON typeExpr)? RPAREN
    ;

restParam
    : LPAREN REST IDENTIFIER (COLON typeExpr)? RPAREN
    ;

literal
    : NUMBER
    | STRING
    | BOOLEAN
    | NULL
    | UNDEFINED
    ;

// ─────────────────────────────────────────────
// Lexer rules
// ─────────────────────────────────────────────

COMMENT
    : ';;' ~[\r\n]* -> skip
    ;

LPAREN      : '(' ;
RPAREN      : ')' ;
COMMA       : ',' ;

// keywords  (order matters – longest match first where needed)
PROGRAM     : 'program' ;
LETSTAR     : 'let*' ;
LET         : 'let' ;
CONSTSTAR   : 'const*' ;
CONST       : 'const' ;
LAMBDA      : 'lambda' ;
FN          : 'fn' ;
METHOD      : 'method' ;
BIND        : 'bind' ;
METHOD_CALL : 'method-call' ;
DEFMACRO        : 'defmacro' ;
MACRO_TIME_ATTR : '#[macro-time]' ;
IF          : 'if' ;
WHILE       : 'while' ;
BEGIN       : 'begin' ;
RETURN      : 'return' ;
THROW       : 'throw' ;
SET         : 'set!' ;
TERNARY     : 'ternary' ;
COND        : 'cond' ;
OBJECT      : 'object' ;
TYPE_ARRAY  : 'type-array' ;
ARRAY       : 'array' ;
OPTCHAIN_INDEX : 'optchain-index' ;
OPTCHAIN    : '.?' ;
DOT         : '.' ;
INDEX       : 'index' ;
NULLCOAL    : '??' ;
QUASI       : 'quasi' ;
QUOTE       : 'quote' ;
UNQUOTE_SPLICING : 'unquote-splicing' ;
UNQUOTE     : 'unquote' ;
NEW         : 'new' ;
IMPORT      : 'import' ;
SWITCH      : 'switch' ;
CASE        : 'case' ;
DEFAULT     : 'default' ;
FORIN       : 'for-in' ;
FOROF       : 'for-of' ;
FORAWAIT    : 'for-await' ;
TRY         : 'try' ;
CATCH       : 'catch' ;
FINALLY     : 'finally' ;
FOR         : 'for' ;

// class-system keywords (order matters: longer tokens before shorter prefixes)
CLASS_BODY      : 'class-body' ;
SUPER_METHOD    : 'super-method' ;
ABSTRACT_METHOD : 'abstract-method' ;
CLASS           : 'class' ;
FIELD           : 'field' ;
CONSTRUCTOR     : 'constructor' ;
THIS            : 'this' ;
SUPER           : 'super' ;
GET             : 'get' ;
SETPROP         : 'set' ;
IMPLEMENTS      : 'implements' ;

// type-system keywords
UNION       : 'union' ;
INTERSECT   : 'intersect' ;
TUPLE       : 'tuple' ;
TYPEFN      : 'tfn' ;
LIT         : 'tlit' ;
KEYOF       : 'keyof' ;
TYPEOF      : 'typeof' ;
TYPE_AS      : 'type-as' ;
INFER       : 'infer' ;
MAPPED      : 'mapped' ;
TYPE_TEMPLATE : 'type-template' ;
TEMPLATE    : 'template' ;
REST        : 'rest' ;
READONLY    : 'readonly' ;
TYPE_PARAMS : 'type-params' ;
TYPE_ARGS   : 'type-args' ;
EXTENDS     : 'extends' ;
RETURNS     : 'returns' ;
TYPE        : 'type' ;
INTERFACE   : 'interface' ;
MODIFIERS   : 'modifiers' ;
OPTIONAL    : '?' ;

BOOLEAN     : 'true' | 'false' ;
NULL        : 'null' ;
UNDEFINED   : 'undefined' ;

COLON       : ':' ;

// async / generator / await / yield primitives
// (order: longer before shorter to avoid prefix ambiguity)
ASYNC_GENERATOR_FN : 'async-generator-fn' ;
ASYNC_LAMBDA       : 'async-lambda' ;
ASYNC_FN           : 'async-fn' ;
GENERATOR_FN       : 'generator-fn' ;
YIELD_STAR         : 'yield*' ;
YIELD              : 'yield' ;
AWAIT              : 'await' ;

// metadata prefix: ^ before a :keyword annotation
CARET              : '^' ;

LBRACK      : '[' ;
RBRACK      : ']' ;

EXPORT      : 'export';
EXPORT_DEFAULT  : 'export-default';
EXPORT_NAMED    : 'export-named';
EXPORT_NS_FROM  : 'export-ns-from';
EXPORT_FROM     : 'export-from';
EXPORT_ALL_FROM : 'export-all-from';
IMPORT_TYPE          : 'import-type' ;
EXPORT_TYPE_ALL_FROM : 'export-type-all-from' ;
EXPORT_TYPE_FROM     : 'export-type-from' ;
EXPORT_TYPE          : 'export-type' ;

// :foo keyword literals — resolve to strings at runtime
KEYWORD
    : ':' ~[() \n\t\r]+
    ;

NUMBER
    : [0-9]+ ('.' [0-9]+)?
    ;

STRING
    : '\'' ( ~['\\] | '\\' . )* '\''
    | '"'  ( ~["\\] | '\\' . )* '"'
    | MULTILINE_STRING
    ;

MULTILINE_STRING
    : '"""' (.)*? '"""'
    ;

IDENTIFIER
    : ~[() \n\t\r:;]+
    ;

WS
    : [ \t\r\n]+ -> skip
    ;
