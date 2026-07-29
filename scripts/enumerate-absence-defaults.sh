#!/usr/bin/env bash
# enumerate-absence-defaults.sh — finds ?? and || fallback sites in packages/
# that may silently supply a legitimate-looking value when none was given.
#
# Usage: bash scripts/enumerate-absence-defaults.sh
#
# Outputs three sections:
#   1. NULLISH COALESCING (??) sites with their fallback value
#   2. ZOD .optional() sites (boundary-level absence admission)
#   3. NULLABLE DB COLUMNS (schema.ts fields without .notNull())
#
# False-positive rate: HIGH — every ?? site is listed; manual classification
# (POLICY vs EVIDENCE, verdict-reaching vs inert) is still required.
#
# False-negative rate: MODERATE — misses:
#   - TypeScript `?` optional fields that are READ without a ?? (caller
#     sees `undefined` and branches, no coalescing site to grep for)
#   - Default parameter values in function signatures
#   - Zod .default([]) / .default("") (syntactically distinct from ??)
#   - Logical OR (||) used as a fallback (rare in this codebase)
#   - z.record(z.string(), z.unknown()) which admits arbitrary keys
#     without any per-key validation — a boundary-level passthrough

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "=== SECTION 1: NULLISH COALESCING (??) SITES ==="
echo "--- Sites defaulting to identity elements ([], 0, {}, \"\", false) ---"
grep -rn '??' packages/ --include='*.ts' --exclude='*.test.ts' --exclude='*.d.ts' \
  | grep -v 'node_modules' \
  | grep -v '^\s*//' \
  | grep -E '\?\? (\[\]|0|\{\}|""|false)' \
  | sort
echo ""
echo "--- Sites defaulting to a named value or string ---"
grep -rn '??' packages/ --include='*.ts' --exclude='*.test.ts' --exclude='*.d.ts' \
  | grep -v 'node_modules' \
  | grep -v '^\s*//' \
  | grep -v -E '\?\? (\[\]|0|\{\}|""|false|null|undefined)$' \
  | sort
echo ""

echo "=== SECTION 2: ZOD .optional() SITES ==="
grep -rn '\.optional()' packages/ --include='*.ts' --exclude='*.test.ts' --exclude='*.d.ts' \
  | grep -v 'node_modules' \
  | sort
echo ""

echo "=== SECTION 3: ZOD z.record(z.string(), z.unknown()) SITES ==="
grep -rn 'z\.record(z\.string(), z\.unknown())' packages/ --include='*.ts' --exclude='*.test.ts' --exclude='*.d.ts' \
  | grep -v 'node_modules' \
  | sort
echo ""

echo "=== SECTION 4: NULLABLE DB COLUMNS (schema.ts fields without .notNull()) ==="
# Lines in schema.ts that define a column but do NOT chain .notNull()
grep -n '^\s\+\w\+:' packages/db/src/schema.ts \
  | grep -v 'notNull\|primaryKey\|references\|default\|unique\|index' \
  | grep -v '^\s*//' \
  | sort
echo ""

echo "=== COUNTS ==="
echo -n "Total ?? sites: "
grep -rn '??' packages/ --include='*.ts' --exclude='*.test.ts' --exclude='*.d.ts' \
  | grep -v 'node_modules' | wc -l
echo -n "Zod .optional() sites: "
grep -rn '\.optional()' packages/ --include='*.ts' --exclude='*.test.ts' --exclude='*.d.ts' \
  | grep -v 'node_modules' | wc -l
echo -n "z.record(z.string(), z.unknown()) sites: "
grep -rn 'z\.record(z\.string(), z\.unknown())' packages/ --include='*.ts' --exclude='*.test.ts' --exclude='*.d.ts' \
  | grep -v 'node_modules' | wc -l
