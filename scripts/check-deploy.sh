#!/usr/bin/env bash
# check-deploy.sh — is the NEW code actually deployed on your CodePilot site?
#
# Usage:
#   ./scripts/check-deploy.sh https://<your-site>.pages.dev
#
# What it tells you:
#   NEW CODE  — the current build is live; check /api/health for missing setup.
#   OLD CODE  — the deploy failed and Cloudflare is serving the last good build.
#               Fix the build (or retry the deployment) — settings are NOT the problem.
#
# The English sentence "Access is not configured." only exists in the old build.
# The current code answers with Persian errors and a JSON /api/health endpoint.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 https://<your-site>" >&2
  exit 2
fi

SITE="${1%/}"
if ! [[ "$SITE" =~ ^https?:// ]]; then
  echo "Error: pass a full URL, e.g. $0 https://codepilot.pages.dev" >&2
  exit 2
fi

echo "Checking: $SITE"
BODY="$(curl -fsSL --max-time 20 "$SITE/api/config" || true)"

if printf '%s' "$BODY" | grep -q 'Access is not configured\.'; then
  echo ""
  echo "❌ STILL OLD CODE"
  echo "   The deploy failed; Cloudflare is serving the previous build."
  echo "   → GitHub: check the 'Cloudflare Pages' status on the latest main commit."
  echo "   → Dashboard: Deployments → latest build → ⋯ → Retry deployment."
  exit 1
fi

if printf '%s' "$BODY" | grep -q 'access_unconfigured'; then
  echo ""
  echo "✅ NEW CODE is deployed."
  echo "   Login is not configured yet — follow SETUP.md (ACCESS_TEAM_DOMAIN /"
  echo "   ACCESS_AUD, or the single-user DEV_ACCESS_EMAIL shortcut)."
  echo "   Diagnostics: curl -s $SITE/api/health | jq"
  exit 0
fi

echo ""
echo "✅ NEW CODE is deployed (no old-code signature found)."
echo "   Full diagnostics: curl -s $SITE/api/health | jq"
