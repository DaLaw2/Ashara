#!/usr/bin/env bash
# enumerate-hardcoded-stack.sh — finds sites where behaviour is decided by a
# hardcoded technology name, filename, extension, marker table, keyword regex
# bank, or command pattern.
#
# Usage: bash scripts/enumerate-hardcoded-stack.sh
#
# Outputs classified sections with file:line, symbol, and class.
#
# FALSE-POSITIVE RATE: MODERATE — any const/set/array whose name or content
# mentions a technology name is listed; some are infrastructure constants
# (e.g. Ashara's own container mounts) rather than stack-deciding logic.
# Manual classification against the four classes is still required for edge
# cases.
#
# FALSE-NEGATIVE RATE: MODERATE — misses:
#   - LLM prompt strings that carry stack priors as natural-language examples
#     rather than as code identifiers (grep finds "lang-go" but not "e.g.
#     a Go binary")
#   - Extension checks embedded in complex expressions that don't match the
#     endsWith/test/Pattern grep patterns
#   - Framework names mentioned only in comments that influence no behaviour
#   - Dynamic construction of technology-specific paths (e.g. string concat
#     building a ".prisma" path from variables)

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "=== SECTION 1: MARKER/MANIFEST TABLES ==="
echo "--- Named constants containing manifest filenames ---"
grep -rn --include='*.ts' -E '^\s*(export\s+)?(const|readonly)\s+\w+.*=.*\[' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v 'node_modules' \
  | grep -iE '(Cargo\.toml|package\.json|tsconfig|go\.mod|pyproject|requirements\.txt|Gemfile|pom\.xml|build\.gradle|bun\.lock|package-lock)' \
  | sort
echo ""

echo "=== SECTION 2: MARKER-TO-LABEL MAPS ==="
echo "--- Record/Map from filenames to language names ---"
grep -rn --include='*.ts' -B1 -A12 'MARKER_LABELS\|LOCKFILE_PRECEDENCE\|NON_NODE_MANIFESTS\|NON_JS_MANIFESTS\|TECH_STACK_MARKERS\|CODEGEN_STEPS' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v 'node_modules' \
  | grep -E '(const |marker|file.*:.*"|".*Cargo|".*package|".*go\.|".*pyproject|".*Gem|".*pom|".*gradle|".*bun|".*prisma)' \
  | sort
echo ""

echo "=== SECTION 3: EXTENSION PATTERNS ==="
echo "--- Regex patterns or endsWith checks matching file extensions ---"
grep -rn --include='*.ts' -E '(endsWith\(\s*"\.|\bSOURCE_FILE_PATTERN|NON_SOURCE_PATTERN|SERVER_FILE_PATTERN|GRAMMARS.*extensions)' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v 'node_modules' \
  | sort
echo ""

echo "=== SECTION 4: COMMAND ALLOWLISTS / TOOL TABLES ==="
echo "--- Named binary sets used in security gates or command policy ---"
grep -rn --include='*.ts' -E '(SAFE_SYSTEM_BINARIES|DEFAULT_ALLOWED_COMMANDS|DEFAULT_BLOCKED_BINARIES|SAFE_GIT_SUBCOMMANDS|SERVER_NPX_TOOLS|SERVER_PYTHON_MODULES|SERVER_SCRIPT_NAMES|BUILD_PATTERNS|TEST_PATTERNS|PackageManager|INSTALL_COMMAND)' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v 'node_modules' \
  | grep -E '(const |type |=)' \
  | sort
echo ""

echo "=== SECTION 5: DIRECTORY SKIP-SETS ==="
echo "--- Named sets of directories to skip during tree walks ---"
grep -rn --include='*.ts' -E '(SKIP_DIRS|FILE_TREE_SKIP_DIRS|BRIDGE_EXCLUDED|EXEMPLAR_DIR)' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v 'node_modules' \
  | grep -E '(const |new Set|=)' \
  | sort
echo ""

echo "=== SECTION 6: ENTRY POINT DETECTION ==="
echo "--- Hardcoded entry-point filenames (src/main.rs, main.go, etc.) ---"
grep -rn --include='*.ts' -E '(src/main\.rs|src/lib\.rs|main\.go|cmd/main\.go|main\.py|app\.py)' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v node_modules \
  | grep -v '^\s*//' \
  | sort
echo ""

echo "=== SECTION 7: TOOL-SPECIFIC COMMAND DISPATCH ==="
echo "--- Places that run a specific tool binary by name ---"
grep -rn --include='*.ts' -E '"(cargo|go|python|python3|bunx|npm|bun)"\s*[,\]]' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v 'node_modules' \
  | sort
echo ""

echo "=== SECTION 8: PROMPT-EMBEDDED STACK PRIORS ==="
echo "--- LLM prompt strings containing technology-specific examples ---"
grep -rn --include='*.ts' -E '(lang-go|db-sqlite|"http"|"cli"|"lib"|mountKind|Cargo\.toml.*Rust|entry_point.*check.*build_tool)' packages/ \
  | grep -v '\.test\.ts' \
  | grep -v 'node_modules' \
  | grep -v 'import ' \
  | sort
echo ""

echo "=== SECTION 9: KNOWN NEGATIVES (should be empty) ==="
echo "--- ALLOWED_CHECK_COMMANDS (deleted this cycle) ---"
grep -rn 'ALLOWED_CHECK_COMMANDS' packages/ --include='*.ts' 2>/dev/null || echo "(none — correct)"
echo ""

echo "=== COUNTS ==="
echo -n "Marker/manifest tables: "
grep -rn --include='*.ts' -E '(TECH_STACK_MARKERS|MARKER_LABELS|NON_NODE_MANIFESTS|NON_JS_MANIFESTS|LOCKFILE_PRECEDENCE|CODEGEN_STEPS)' packages/ \
  | grep -v '\.test\.ts' | grep -v 'node_modules' | grep -c 'const '
echo -n "Extension patterns: "
grep -rn --include='*.ts' -E '(endsWith\(\s*"\.|\bSOURCE_FILE_PATTERN|NON_SOURCE_PATTERN|SERVER_FILE_PATTERN|GRAMMARS)' packages/ \
  | grep -v '\.test\.ts' | grep -v 'node_modules' | wc -l
echo -n "Command allowlists/tables: "
grep -rn --include='*.ts' -E '(SAFE_SYSTEM_BINARIES|DEFAULT_ALLOWED_COMMANDS|DEFAULT_BLOCKED_BINARIES|BUILD_PATTERNS|TEST_PATTERNS|PackageManager|INSTALL_COMMAND)' packages/ \
  | grep -v '\.test\.ts' | grep -v 'node_modules' | grep -c -E '(const |type |=)'
echo -n "Directory skip-sets: "
grep -rn --include='*.ts' -E '(SKIP_DIRS|FILE_TREE_SKIP_DIRS|BRIDGE_EXCLUDED|EXEMPLAR_DIR)' packages/ \
  | grep -v '\.test\.ts' | grep -v 'node_modules' | grep -c -E '(const |new Set|=)'
