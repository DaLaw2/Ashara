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
      "JSON.parse outside parseJson (every boundary validates its input with Zod). Use parseJson(schema, text, source) from @ashara/shared, which validates the value and throws a typed error.",
  },
  {
    // Typed errors only (CLAUDE.md). Blind spots: other built-in classes (`new TypeError(`), a
    // typed class whose context fields are empty, a `throw` of a non-Error value, and Error reached
    // through an alias or `Reflect.construct`.
    selector: ":matches(NewExpression, CallExpression)[callee.type='Identifier'][callee.name='Error']",
    message:
      "Bare Error (typed errors only). Throw a class extending Error whose fields carry the structured context; the message alone must say what, where and why.",
  },
];

// A test that waits a fixed time for something to happen is slow whenever the thing is quick and
// flaky whenever it is slow: poll for the condition, or await the event, instead. A wait that is
// itself what the test judges keeps `// eslint-disable-next-line no-restricted-syntax -- <why>`.
// Blind spots: a duration held in a variable or a constant (`setTimeout(r, WAIT_MS)`), a callback
// with a body block (`setTimeout(() => { resolve(); }, 1500)`), a timer
// reached through a member (`timers.setTimeout`) or another name, a wait under 500 ms repeated in a
// loop, and a busy-wait on `Date.now()`.
const FIXED_WAIT_MS = 500;
const TEST_SYNTAX = [
  {
    // `setTimeout(resolve, ms)` and `setTimeout(() => resolve(), ms)` are waits;
    // `setTimeout(() => reject(new Timeout()), ms)` bounds one and passes.
    selector: [
      `CallExpression[callee.name='setTimeout'][arguments.0.type='Identifier'][arguments.1.type='Literal'][arguments.1.value>=${FIXED_WAIT_MS}]`,
      `CallExpression[callee.name='setTimeout'][arguments.0.type='ArrowFunctionExpression'][arguments.0.body.type='CallExpression'][arguments.0.body.arguments.length=0][arguments.1.type='Literal'][arguments.1.value>=${FIXED_WAIT_MS}]`,
      `CallExpression:matches([callee.name='sleep'], [callee.name='delay'])[arguments.0.type='Literal'][arguments.0.value>=${FIXED_WAIT_MS}]`,
    ].join(", "),
    message: `Fixed wait of ${FIXED_WAIT_MS} ms or more in a test. Poll for the condition the test waits on, or await its event; a wait that is itself under test keeps \`// eslint-disable-next-line no-restricted-syntax -- <why>\`.`,
  },
];

// Discipline A: a catch that neither rethrows nor returns continues as if the failed operation
// succeeded, so a failure that a verdict, a counter, a charge, persisted state or client text
// depends on is dropped with only a log line to show for it. Every such catch in production source
// fails unless it is argued, as the catch's first line: `// eslint-disable-next-line
// ashara/catch-continue -- best effort: <why the dropped failure changes no verdict, counter,
// charge or client text>`. A disable whose description does not start with `best effort:` is
// itself reported, on its own line.
// A `throw` or `return` counts only at the catch's own function level: one inside a nested
// function or class does not leave the catch.
// Blind spots: a catch that returns a fallback value (`return null`, `return []`: the
// identity-element rule sees only constant identities), a rethrow of a different error that drops
// the cause, a `throw`/`return` on one branch only (`if (x) throw e;` exits on some paths), a
// `continue`/`break`/`process.exit` that leaves by another route (reported, argue it), logic after
// the try statement that reads state the catch left half-written, the promise form
// (`.catch((e) => log(e))`, which the swallowed-rejection rule sees only when the handler is
// constant), and a block, file-wide or same-line disable, which silences the report of its own
// missing argument too.
const FUNCTION_BOUNDARY = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
]);
const exitsCatch = (node) => {
  if (node === null || typeof node !== "object") return false;
  if (node.type === "ThrowStatement" || node.type === "ReturnStatement") return true;
  if (FUNCTION_BOUNDARY.has(node.type)) return false;
  return Object.entries(node).some(([key, value]) => {
    if (key === "parent" || key === "loc" || key === "range") return false;
    return Array.isArray(value) ? value.some(exitsCatch) : typeof value?.type === "string" && exitsCatch(value);
  });
};
const CATCH_CONTINUE = "catch-continue";
// A next-line disable naming the rule is argued only when its description starts with `best effort:`.
const isUnarguedDirective = (text) => {
  if (!/^\s*eslint-disable-next-line\s/.test(text)) return false;
  const [rules, ...description] = text.split(/\s-{2,}\s/);
  if (!rules.trim().split(/[\s,]+/).includes(`ashara/${CATCH_CONTINUE}`)) return false;
  return !/^best effort:\s*\S/.test(description.join(" -- ").trim());
};
// A call on the Logger from @ashara/shared, told apart without type information by its receiver's
// name: every Logger in production source is held as `logger` (a parameter, a field, a deps member).
// Blind spots: a Logger held under another name, destructured methods (`const { warn } = logger`),
// and an unrelated object that happens to be named `logger`.
const LOG_METHODS = new Set(["debug", "info", "warn", "error"]);
const RECEIVER_NAMES = new Set(["logger", "log"]);
const loggerMethod = (call) => {
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return null;
  if (!LOG_METHODS.has(callee.property.name)) return null;
  const receiver = callee.object;
  const name = receiver.type === "Identifier" ? receiver.name : receiver.type === "MemberExpression" && !receiver.computed && receiver.property.type === "Identifier" ? receiver.property.name : null;
  return name !== null && RECEIVER_NAMES.has(name) ? callee.property.name : null;
};
const childNodes = (node) =>
  Object.entries(node).flatMap(([key, value]) => {
    if (key === "parent" || key === "loc" || key === "range") return [];
    if (Array.isArray(value)) return value.filter((item) => typeof item?.type === "string");
    return typeof value?.type === "string" ? [value] : [];
  });
const referencesAny = (node, names) => {
  if (node === null || typeof node !== "object") return false;
  if (node.type === "Identifier" && names.has(node.name)) return true;
  return childNodes(node).some((child) => referencesAny(child, names));
};
// The names in a catch body that hold the caught error or a value built from it (`const fault =
// new Fault(..., { cause: e })`), in declaration order, not crossing into a nested function.
const derivedNames = (catchClause) => {
  const names = new Set([catchClause.param.name]);
  const visit = (node) => {
    if (FUNCTION_BOUNDARY.has(node.type)) return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init !== null && referencesAny(node.init, names)) names.add(node.id.name);
    childNodes(node).forEach(visit);
  };
  visit(catchClause.body);
  return names;
};
const enclosingCatch = (node) => {
  for (let at = node.parent; at !== null && at !== undefined; at = at.parent) {
    if (at.type === "CatchClause") return at;
    if (FUNCTION_BOUNDARY.has(at.type)) return null;
  }
  return null;
};
// Constructors a block may bind beside a warn without the bound value being the failure it reports.
const NOT_FAILURES = new Set(["Map", "Set", "WeakMap", "WeakSet", "Date", "URL", "RegExp", "Array", "Promise", "AbortController", "TextDecoder", "TextEncoder"]);
// The names a statement list binds to `new <Class>(...)` before `statement`: a failure built to be
// recorded, which the record reporting it should carry.
const failuresBuiltBefore = (statement) => {
  const block = statement.parent;
  if (block === null || block === undefined || !Array.isArray(block.body)) return [];
  const before = block.body.slice(0, block.body.indexOf(statement));
  return before.flatMap((sibling) =>
    sibling.type !== "VariableDeclaration"
      ? []
      : sibling.declarations.filter(
          (declarator) => declarator.id.type === "Identifier" && declarator.init?.type === "NewExpression" && declarator.init.callee.type === "Identifier" && /^[A-Z]/.test(declarator.init.callee.name) && !NOT_FAILURES.has(declarator.init.callee.name),
        ),
  ).map((declarator) => declarator.id.name);
};

// Discipline C: a warn or error record about a failure carries the failure in the Logger's
// `error` argument (its fourth), where it is serialized as a chain that survives the boundary; a
// message that quotes `e.message` keeps neither the class, the context nor the cause.
// It reports a warn/error call inside a catch whose fourth argument is missing or does not reference
// the caught error (or a value built from it), and one whose statement follows a `const x = new
// C(...)` in the same block that the fourth argument does not reference.
// Blind spots: a failure passed into a helper that logs it, a failure built inline (`f(new C())`),
// a failure class constructed in another block, a result value standing for a failure (an
// ErrorLayer on a returned object), and a catch that logs at info.
const LOG_ERROR_FIELD = "log-error-field";
// Discipline C: an event name is the stable key a reader asserts on, so it is a string literal
// `<package>.<kebab-case-what>`, with the package the file's own.
// Blind spots: a file outside `packages/<pkg>/src/`, and a template literal without expressions.
const LOG_EVENT_NAME = "log-event-name";
const KEBAB_WHAT = /^[a-z0-9-]+$/;
const packageOf = (filename) => /(?:^|[\\/])packages[\\/]([^\\/]+)[\\/]src[\\/]/.exec(filename)?.[1] ?? null;
const ashara = {
  rules: {
    [LOG_ERROR_FIELD]: {
      meta: {
        type: "problem",
        messages: {
          caught:
            "Log record drops its error (Discipline C). This warn/error call is inside a catch but its fourth argument does not carry the caught error, so the record keeps no class, context or cause. Pass the caught error, or a typed error built from it, as the `error` argument: `logger.warn(event, msg, fields, e)`.",
          built:
            "Log record drops its error (Discipline C). `{{name}}` is built just above as the failure this record reports, but the call's fourth argument does not carry it. Pass it as the `error` argument: `logger.error(event, msg, fields, {{name}})`.",
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            const method = loggerMethod(node);
            if (method !== "warn" && method !== "error") return;
            const passed = node.arguments[3];
            const caught = enclosingCatch(node);
            if (caught !== null) {
              const names = caught.param?.type === "Identifier" ? derivedNames(caught) : new Set();
              if (passed === undefined || !referencesAny(passed, names)) {
                context.report({ node, messageId: "caught" });
                return;
              }
            }
            if (node.parent.type !== "ExpressionStatement") return;
            const dropped = failuresBuiltBefore(node.parent).find((name) => passed === undefined || !referencesAny(passed, new Set([name])));
            if (dropped !== undefined) context.report({ node, messageId: "built", data: { name: dropped } });
          },
        };
      },
    },
    [LOG_EVENT_NAME]: {
      meta: {
        type: "problem",
        messages: {
          notLiteral:
            "Log event name is not a literal (Discipline C). A reader asserts on the event name, so it is a string literal `{{prefix}}.<kebab-case-what>` a search finds, not a computed value.",
          malformed:
            "Log event name `{{name}}` does not match `{{prefix}}.<kebab-case-what>` (Discipline C): the prefix is this file's package and the rest is lowercase letters, digits and hyphens.",
        },
        schema: [],
      },
      create(context) {
        const prefix = packageOf(context.filename);
        if (prefix === null) return {};
        return {
          CallExpression(node) {
            if (loggerMethod(node) === null) return;
            const event = node.arguments[0];
            if (event === undefined) return;
            if (event.type !== "Literal" || typeof event.value !== "string") {
              context.report({ node: event, messageId: "notLiteral", data: { prefix } });
              return;
            }
            const [head, ...rest] = event.value.split(".");
            const what = rest.join(".");
            if (head !== prefix || !KEBAB_WHAT.test(what)) context.report({ node: event, messageId: "malformed", data: { name: event.value, prefix } });
          },
        };
      },
    },
    [CATCH_CONTINUE]: {
      meta: {
        type: "problem",
        messages: {
          continues:
            "Catch continues (Discipline A). This catch neither rethrows nor returns, so the code after it runs as if the failed operation succeeded. If a verdict, a counter, a charge, persisted state another path trusts, or client text depends on the operation, propagate a typed error or record the failure where that path reads it. If nothing depends on it, argue it: `// eslint-disable-next-line ashara/catch-continue -- best effort: <why the dropped failure changes no verdict, counter, charge or client text>`.",
          unargued:
            "Unargued catch-continue disable (Discipline A). The description must start with `best effort:` and say why the dropped failure changes no verdict, counter, charge or client text.",
        },
        schema: [],
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (isUnarguedDirective(comment.value)) context.report({ loc: comment.loc, messageId: "unargued" });
            }
          },
          CatchClause(node) {
            // Reported on the catch's first statement, so the argued disable is the catch's first line.
            if (!exitsCatch(node.body)) context.report({ node: node.body.body[0] ?? node, messageId: "continues" });
          },
        };
      },
    },
  },
};

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
    // Test files. A config object's rule options replace an earlier object's, so the base selectors
    // are repeated here.
    files: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...BASE_SYNTAX, ...TEST_SYNTAX],
    },
  },
  {
    // Production source and operator scripts. A config object's rule options replace an earlier
    // object's, so the base selectors are repeated here.
    files: ["packages/*/src/**/*.ts", "scripts/**/*.ts"],
    ignores: ["**/*.test.ts"],
    plugins: { ashara },
    rules: {
      "no-restricted-syntax": ["error", ...BASE_SYNTAX, ...PRODUCTION_SYNTAX],
      [`ashara/${CATCH_CONTINUE}`]: "error",
      [`ashara/${LOG_ERROR_FIELD}`]: "error",
      [`ashara/${LOG_EVENT_NAME}`]: "error",

      // No unvalidated `as` (CLAUDE.md): every assertion fails; `as const` stays legal. A cast
      // that follows a validation keeps an argued disable naming the validation.
      // Blind spots: a lying type guard (`x is T` that checks nothing), a non-null `!`, a generic
      // that returns an unchecked T, `satisfies` (checked, so legal), and `JSON.parse`'s `any`
      // assigned to a typed variable (the JSON.parse rule covers that).
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
  },
  {
    // Delivery and quality log through their injected Logger, so every line carries an event name,
    // a level and the correlation scope. A test may print what it inspects, so tests are exempt.
    files: ["packages/delivery/src/**/*.ts", "packages/quality/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Delivery's jobs stay one reviewable function each. Blind spot: a long job cut into helpers
    // that are each under the bound but still share no seam.
    files: ["packages/delivery/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "max-lines-per-function": ["error", { max: 200, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    // The dispatch and its routing take a named-parameter object past five values, so no call
    // site can swap two of the same type unseen.
    files: ["packages/delivery/src/execution/**/*.ts", "packages/delivery/src/dispatch/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "max-params": ["error", 5],
    },
  },
  {
    // Every route that reopens, requeues, parks or gives up an item after a dispatch goes through
    // reopen(), which alone reads an InvalidStatusTransition as "the item moved". A config object's
    // rule options replace an earlier object's, so the production selectors are repeated here.
    // Blind spot: a route that catches it under another name, or never catches it at all.
    files: ["packages/delivery/src/execution/**/*.ts"],
    ignores: ["**/*.test.ts", "packages/delivery/src/execution/reopen.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...BASE_SYNTAX,
        ...PRODUCTION_SYNTAX,
        {
          selector: "BinaryExpression[operator='instanceof'][right.name='InvalidStatusTransition']",
          message:
            "A route that reopens, requeues, parks or gives up a work item supplies its exit to reopen() (execution/reopen.ts), which owns the find, the transition, the InvalidStatusTransition handling, the save or refund, the events and the log. A branch that is no reopen keeps an argued disable.",
        },
      ],
    },
  },
);
