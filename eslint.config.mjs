import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";

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
      "no-restricted-syntax": [
        "error",
        {
          selector: "CatchClause > BlockStatement[body.length=0]",
          message:
            "Empty catch block (Discipline C). A comment is not a handler: log at warn or above with structured context, or let the error propagate. If the throw is genuinely expected and irrelevant, say so in a log line, not in a comment.",
        },
        {
          // The promise form of an empty catch block. A rejection handler that declares no
          // parameter cannot report its cause, whatever its body (`.catch(() => undefined)`); one
          // whose body is empty or a bare constant drops it unseen too.
          selector: [
            "CallExpression[callee.property.name='catch'] > :matches(ArrowFunctionExpression, FunctionExpression):matches([params.length=0], [body.type='BlockStatement'][body.body.length=0], [body.type=/^(Literal|ObjectExpression|ArrayExpression)$/], [body.type='Identifier'][body.name='undefined'], [body.type='UnaryExpression'][body.operator='void'])",
            "CallExpression[callee.property.name='then'][arguments.length=2] > :matches(ArrowFunctionExpression, FunctionExpression):nth-child(2):matches([params.length=0], [body.type='BlockStatement'][body.body.length=0], [body.type=/^(Literal|ObjectExpression|ArrayExpression)$/], [body.type='Identifier'][body.name='undefined'], [body.type='UnaryExpression'][body.operator='void'])",
          ].join(", "),
          message:
            "Swallowed promise rejection (Discipline C). A rejection handler that takes no parameter, or returns nothing but a constant, drops the cause unseen: log it at warn or above with its cause, or let it propagate. To wait for a promise to settle whatever its outcome, while the rejection reaches its caller by another reference, use Promise.allSettled.",
        },
      ],

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
);
