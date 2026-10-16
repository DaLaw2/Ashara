import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";

// A rejection handler that reports nothing: no parameter, an empty body, or a body (or a lone
// `return`) that is a bare constant: a literal (null included), `undefined`, `void x`, a negated
// literal, an array or object literal, a constant template.
const constantAt = (path) =>
  [
    `[${path}.type='Literal']`,
    `[${path}.type='Identifier'][${path}.name='undefined']`,
    `[${path}.type='UnaryExpression'][${path}.operator='void']`,
    `[${path}.type='UnaryExpression'][${path}.argument.type='Literal']`,
    `[${path}.type='ArrayExpression']`,
    `[${path}.type='ObjectExpression']`,
    `[${path}.type='TemplateLiteral'][${path}.expressions.length=0]`,
  ].join(", ");
const LONE_RETURN = "[body.type='BlockStatement'][body.body.length=1][body.body.0.type='ReturnStatement']";
const SWALLOWING_HANDLER = [
  "[params.length=0]",
  "[body.type='BlockStatement'][body.body.length=0]",
  constantAt("body"),
  `${LONE_RETURN}:matches([body.body.0.argument=null], ${constantAt("body.body.0.argument")})`,
].join(", ");

// A constant right side of `??`/`||`, or a constant a catch returns, that is an identity element:
// zero, the empty string, the empty array or object, `false`, "unknown".
const identityAt = (path) =>
  [
    `[${path}.type='Literal'][${path}.raw=/^(0|""|''|false|"unknown"|'unknown')$/]`,
    `[${path}.type='ArrayExpression'][${path}.elements.length=0]`,
    `[${path}.type='ObjectExpression'][${path}.properties.length=0]`,
    `[${path}.type='TemplateLiteral'][${path}.expressions.length=0][${path}.quasis.0.value.raw=/^$/]`,
  ].join(", ");

const BASE_SYNTAX = [
  {
    selector: "CatchClause > BlockStatement[body.length=0]",
    message:
      "Empty catch block (Discipline C). A comment is not a handler: log at warn or above with structured context, or let the error propagate. If the throw is genuinely expected and irrelevant, say so in a log line, not in a comment.",
  },
  {
    // The promise form of an empty catch block, for `.catch(h)` and the reject handler of a
    // two-argument `.then(onOk, h)`.
    // Blind spots: a handler passed by name (`.catch(noop)`), one that logs below warn or only
    // touches its parameter (`(e) => { void e; }`), one that returns a non-constant fallback
    // (`() => defaults`), a `try { await p } catch` that drops (the catch-clause rules see that),
    // and a promise never awaited at all (no type-aware no-floating-promises runs).
    selector: [
      `CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression):matches(${SWALLOWING_HANDLER})`,
      `CallExpression[callee.property.name='then'][arguments.length=2] > :matches(ArrowFunctionExpression, FunctionExpression):nth-child(2):matches(${SWALLOWING_HANDLER})`,
    ].join(", "),
    message:
      "Swallowed promise rejection (Discipline C). A rejection handler that takes no parameter, or returns nothing but a constant, drops the cause unseen: log it at warn or above with its cause, or let it propagate. To wait for a promise to settle whatever its outcome, while the rejection reaches its caller by another reference, use Promise.allSettled.",
  },
];

const PRODUCTION_SYNTAX = [
  {
    // Discipline A: the identity element of a sum, a collection or a conjunction reads as "fine",
    // so a fallback to one turns absent evidence into a passing verdict. A site that is a policy
    // default keeps `// eslint-disable-next-line no-restricted-syntax -- policy default: <why>`;
    // one whose absence is evidence fails closed instead (a required field, a typed Unknown, a throw).
    // Blind spots: a ternary (`x === undefined ? 0 : x`), a default parameter or destructuring
    // default (`{ n = 0 }`), Zod `.default()`/`.catch()`/`.optional()` read as a value, SQL
    // COALESCE, a lying type guard, a non-null `!`, a fallback to a named constant
    // (`?? EMPTY`), `null`/`undefined` fallbacks, and a catch that logs and then drops (returns
    // nothing, or returns a value through a variable).
    selector: [
      `LogicalExpression[operator=/^(\\?\\?|\\|\\|)$/]:matches(${identityAt("right")})`,
      `AssignmentExpression[operator=/^(\\?\\?=|\\|\\|=)$/]:matches(${identityAt("right")})`,
      `CatchClause > BlockStatement > ReturnStatement:matches(${identityAt("argument")})`,
    ].join(", "),
    message:
      "Identity-element fallback (Discipline A). `?? 0`, `|| []`, `?? {}`, `|| \"unknown\"` or a catch returning one reads absent evidence as \"fine\". If the absence is evidence, fail closed: a required field, a typed Unknown, a throw. If it is a policy default, say so: `// eslint-disable-next-line no-restricted-syntax -- policy default: <why>`.",
  },
  {
    // Zod at every boundary: text becomes a value only through parseJson(schema, text, source) in
    // @ashara/shared, which validates it and throws a typed error. Blind spots: a schema that is
    // `z.unknown()` or `z.any()` (a caller that validates afterwards, or never), JSON.parse reached
    // through an alias (`const { parse } = JSON`, `globalThis.JSON`), a parse by another library,
    // `Response.json()`, and a JSON module import.
    selector: "MemberExpression[object.name='JSON'][property.name='parse']",
    message:
      "JSON.parse outside parseJson (CLAUDE.md: Zod at every boundary). Use parseJson(schema, text, source) from @ashara/shared, which validates the value and throws a typed error.",
  },
  {
    // Typed errors only (CLAUDE.md). Blind spots: other built-in classes (`new TypeError(`), a
    // typed class whose context fields are empty, a `throw` of a non-Error value, and Error reached
    // through an alias or `Reflect.construct`.
    selector: ":matches(NewExpression, CallExpression)[callee.type='Identifier'][callee.name='Error']",
    message:
      "Bare Error (CLAUDE.md: typed errors only). Throw a class extending Error whose fields carry the structured context; the message alone must say what, where and why.",
  },
];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".claude/**"],
  },
  {
    files: [
      "packages/*/src/**/*.ts",
      "packages/*/test/**/*.ts",
      "scripts/**/*.ts",
    ],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "import-x": importX,
    },
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      // No explicit `any` — CLAUDE.md: "No `any` type."
      "@typescript-eslint/no-explicit-any": "error",

      // No empty catch blocks — CLAUDE.md Discipline C.
      //
      // `no-empty` alone does NOT enforce this rule. It ignores any block
      // containing a comment, so `catch { /* ignore */ }` passes it. No
      // syntactically empty catches remain, but the gate says nothing about
      // catches with at least one statement: `catch { return null; }` passes
      // regardless of whether the error needed logging (Discipline C).
      //
      // The selector matches on STATEMENT count, and a comment is not a
      // statement, so it enforces what CLAUDE.md actually writes: a catch that
      // does nothing is a defect regardless of how it is annotated.
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-restricted-syntax": ["error", ...BASE_SYNTAX],

      // Import order — CLAUDE.md: node built-ins → external → @ashara/* → relative
      "import-x/order": [
        "error",
        {
          groups: [
            "builtin",
            "external",
            "internal",
            ["parent", "sibling", "index"],
          ],
          pathGroups: [
            {
              pattern: "@ashara/**",
              group: "internal",
              position: "before",
            },
          ],
          pathGroupsExcludedImportTypes: [],
          "newlines-between": "never",
          alphabetize: { order: "ignore" },
        },
      ],
    },
  },
  {
    // Production source and operator scripts. A config object's rule options replace an earlier
    // object's, so the base selectors are repeated here.
    files: ["packages/*/src/**/*.ts", "scripts/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...BASE_SYNTAX, ...PRODUCTION_SYNTAX],

      // No unvalidated `as` (CLAUDE.md): every assertion fails; `as const` stays legal. A cast
      // that follows a validation keeps an argued disable naming the validation.
      // Blind spots: a lying type guard (`x is T` that checks nothing), a non-null `!`, a generic
      // that returns an unchecked T, `satisfies` (checked, so legal), and `JSON.parse`'s `any`
      // assigned to a typed variable (the JSON.parse rule covers that).
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
  },
);
