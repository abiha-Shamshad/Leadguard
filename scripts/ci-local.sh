#!/usr/bin/env bash
# Runs every CI stage locally and prints a summary. Usage: bash scripts/ci-local.sh
# The browser stage needs the stack running (pnpm dev:stack + web on :3000); it is skipped otherwise.
set -u
cd "$(dirname "$0")/.."
export PYTHONUTF8=1
# pnpm may only be available through corepack on developer machines.
if ! command -v pnpm >/dev/null 2>&1; then
  mkdir -p .ci-bin && printf '#!/usr/bin/env bash
exec corepack pnpm "$@"
' > .ci-bin/pnpm && chmod +x .ci-bin/pnpm
  printf '@corepack pnpm %%*
' > .ci-bin/pnpm.cmd  # nested pnpm calls from package scripts run under cmd on Windows
  export PATH="$PWD/.ci-bin:$PATH"
fi
RESULTS=()
run() {
  local name="$1"; shift
  echo "=== $name"
  local start=$SECONDS
  if "$@" > ".ci-$name.log" 2>&1; then RESULTS+=("PASS  $name ($((SECONDS - start))s)"); else RESULTS+=("FAIL  $name ($((SECONDS - start))s) - see .ci-$name.log"); fi
}
run typecheck        pnpm typecheck
run spec-check       python docs/spec/tools/check_spec.py
run audit            pnpm audit --audit-level high
run domain           pnpm --filter @leadguard/domain test
run contracts        pnpm --filter @leadguard/contracts test
run worker           pnpm --filter @leadguard/worker test
run web-unit         pnpm --filter @leadguard/web test
run db-checks        pnpm --filter @leadguard/db test
run api-e2e          node --import tsx --test --test-concurrency=1 apps/api/test/e2e.test.ts
run api-contract     node --import tsx --test --test-concurrency=1 apps/api/test/contract.test.ts
run api-security     node --import tsx --test --test-concurrency=1 apps/api/test/security.test.ts
run smoke            pnpm smoke
if curl -sf localhost:3000/sign-in >/dev/null && curl -sf localhost:3001/internal/v1/health >/dev/null; then
  run browser-e2e    pnpm --filter @leadguard/web test:e2e
else
  RESULTS+=("SKIP  browser-e2e (start pnpm dev:stack and the web app first)")
fi
echo
printf '%s\n' "${RESULTS[@]}"
