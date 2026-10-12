#!/usr/bin/env bash
# Runs the same steps as the `test` job in .github/workflows/ci.yml:
# clean install (npm 11), production audit, typecheck, tests.
# Usage: scripts/ci.sh [--skip-install]   (--skip-install keeps the current node_modules)
set -euo pipefail
cd "$(dirname "$0")/.."

skip_install=0
[[ "${1:-}" == "--skip-install" ]] && skip_install=1

# Switch to the .nvmrc Node via nvm when it's installed (affects this script only).
nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [[ -s "$nvm_sh" ]]; then
  set +eu # nvm.sh isn't safe under -e/-u
  unset npm_config_prefix # set by `npm run`; nvm refuses to switch while it's set
  source "$nvm_sh"
  nvm use >/dev/null || echo "warning: nvm couldn't switch to Node $(cat .nvmrc) (try: nvm install)" >&2
  set -eu
fi

# CI uses the Node major from .nvmrc; a different local version can hide or cause failures.
want="$(tr -d 'v[:space:]' < .nvmrc)"
have="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$have" != "$want" ]]; then
  echo "warning: Node $have locally, CI uses Node $want (.nvmrc)" >&2
fi

# npm 10 (bundled with Node 22) hits an arborist bug on this dependency tree; CI uses npm 11.
npm11=(npx -y npm@11)

step() { echo; echo "==> $*"; }

if (( ! skip_install )); then
  step "npm ci"
  "${npm11[@]}" ci --no-audit --no-fund
fi
step "npm audit --omit=dev --audit-level=high"
"${npm11[@]}" audit --omit=dev --audit-level=high
step "npm run typecheck"
npm run typecheck
step "npm test (Node $(node -v))"
npm test

echo; echo "CI test job passed."
