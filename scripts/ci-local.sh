#!/usr/bin/env bash
# Runs the CI pipeline's exact command sequence locally, including the clean install
# that CI performs on a fresh checkout.
#
# The reason this exists: verifying the individual steps is not the same as verifying
# the pipeline. Two CI failures were caused by a stale lockfile and a missing generate
# step that every local check passed straight over, because local node_modules was
# already in the desired state and pnpm short-circuits.
#
#   ./scripts/ci-local.sh          # fast: skips the clean reinstall
#   ./scripts/ci-local.sh --clean  # what CI actually does; use before pushing
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() {
  printf '  %-28s' "$1"; shift
  if "$@" >/tmp/mn-ci-step.log 2>&1; then echo "OK"; else
    echo "FAIL"; fail=1; tail -20 /tmp/mn-ci-step.log | sed 's/^/      /'
  fi
}

if [[ "${1:-}" == "--clean" ]]; then
  echo "== clean checkout simulation =="
  rm -rf node_modules apps/*/node_modules packages/*/node_modules
fi

echo "== job: static =="
step "install --frozen-lockfile" pnpm install --frozen-lockfile
step "packages build"            pnpm --filter "./packages/**" build
step "db:generate"               pnpm db:generate
step "format:check"              pnpm format:check
step "lint"                      pnpm lint
step "typecheck"                 pnpm typecheck

echo "== job: unit =="
step "test:unit"                 pnpm -r test:unit

echo "== job: integration =="
if docker info >/dev/null 2>&1; then
  step "test:int"                pnpm --filter @masternova/api test:int
else
  echo "  test:int                     SKIPPED (no docker in this shell; try: sg docker -c './scripts/ci-local.sh')"
fi

echo
[[ $fail -eq 0 ]] && echo "ALL GREEN" || echo "FAILURES ABOVE"
exit $fail
