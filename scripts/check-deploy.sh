#!/usr/bin/env bash
# Is my live site actually running the latest code?
#
#   ./scripts/check-deploy.sh https://codepilot-cloudflare.pages.dev
#
# Why this exists: when a Cloudflare Pages deploy fails, Cloudflare keeps
# serving the last successful build and only shows a small red mark in the
# dashboard. So "I merged it and the site still shows the old error" is almost
# always a failed deploy, not a code bug. This tells the two apart.
#
# Exit codes: 0 = new code, 1 = unreachable, 2 = stale build.
set -u

SITE="${1:-}"
if [ -z "$SITE" ]; then
  echo "usage: $0 https://your-site.pages.dev"
  exit 1
fi
SITE="${SITE%/}"

BODY=$(curl -s -m 20 "$SITE/api/health" || true)

if [ -z "$BODY" ]; then
  echo "✗ no response from $SITE"
  echo "  Check the URL, or whether the deployment is up at all."
  exit 1
fi

# The health endpoint only exists in the current code. If it answers with JSON
# containing authMode, the deploy went through.
if printf '%s' "$BODY" | grep -q '"authMode"'; then
  echo "✓ new code is live — /api/health answered"
  printf '%s' "$BODY" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$BODY"
  exit 0
fi

# Anything else means an older build is serving. Be specific about the cause,
# because the fix is in the Cloudflare dashboard, not in the code.
echo "✗ STALE BUILD — the site is serving an older version of the code"
echo
echo "  /api/health does not exist in what's deployed right now. A failed"
echo "  deploy leaves the previous build in place, so pushes and even merges"
echo "  can be invisible on the live site."
echo

# Try to confirm from a public endpoint of the old build.
CHAT=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$SITE/api/chat" 2>/dev/null || echo '000')
case "$CHAT" in
  000) echo "  (could not reach /api/chat to confirm)" ;;
  *)   echo "  /api/chat currently answers HTTP $CHAT" ;;
esac

echo
echo "  Fix, in order:"
echo "  1. github.com -> Actions/checks on the latest main commit ->"
echo "     is 'Cloudflare Pages' red? That is the failed deploy."
echo "  2. Cloudflare dash -> Workers & Pages -> codepilot-cloudflare ->"
echo "     Deployments -> newest build -> '...' -> Retry deployment"
echo "  3. If it keeps failing, open the build log. A placeholder D1"
echo "     database_id in wrangler.toml is the usual cause."
echo
echo "  Run this script again afterwards."
exit 2
