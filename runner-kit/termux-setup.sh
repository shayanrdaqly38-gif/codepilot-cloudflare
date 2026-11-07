#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "🚀 در حال آماده‌سازی پل مستقیم Termux برای CodePilot..."
if ! command -v node >/dev/null 2>&1; then
  pkg update -y && pkg install -y nodejs git
fi

mkdir -p "$HOME/codepilot-runner" "$HOME/codepilot-workspace"

TOKEN_FILE="$HOME/codepilot-runner/.cp_token"
if [ -n "$CP_TOKEN" ]; then
  printf "%s" "$CP_TOKEN" > "$TOKEN_FILE"
elif [ ! -s "$TOKEN_FILE" ]; then
  node -e "process.stdout.write('cp_' + require('crypto').randomBytes(18).toString('hex'))" > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/server.mjs" ]; then
  cp "$SCRIPT_DIR/server.mjs" "$HOME/codepilot-runner/server.mjs"
fi

cat << 'EOF' > "$HOME/codepilot-runner/start.sh"
#!/data/data/com.termux/files/usr/bin/bash
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi
export PORT="${PORT:-8787}"
export HOST="${HOST:-127.0.0.1}"
export CP_TOKEN="$(cat "$HOME/codepilot-runner/.cp_token")"
echo "================================================="
echo "📱 CodePilot Direct Termux Bridge"
echo "🔗 Local URL : http://127.0.0.1:${PORT}"
echo "🔑 Token     : ${CP_TOKEN}"
echo "================================================="
exec node "$HOME/codepilot-runner/server.mjs"
EOF
chmod +x "$HOME/codepilot-runner/start.sh"

exec "$HOME/codepilot-runner/start.sh"
