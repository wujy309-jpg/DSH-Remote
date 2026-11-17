#!/usr/bin/env bash
# 在 Mac 上装 agent：自包含副本 + 配置 + LaunchAgent（开机自启、崩溃自动拉起）。
#
#   bash deploy/install-agent.sh <agentToken> <relayUrl>
#
# relayUrl 也可以走环境变量 DSH_REMOTE_URL（例如 https://dsh.example.com）。
set -euo pipefail

TOKEN="${1:?用法: install-agent.sh <agentToken> <relayUrl>}"
RELAY="${2:-${DSH_REMOTE_URL:-}}"
if [ -z "$RELAY" ]; then
  echo "错误：缺少 relayUrl。用法: install-agent.sh <agentToken> <relayUrl>" >&2
  exit 1
fi
RELAY="${RELAY%/}"
case "$RELAY" in
  https://*) ;;
  *)
    echo "错误：relayUrl 必须是 https:// 开头（手机端要过 TLS）：$RELAY" >&2
    exit 1
    ;;
esac

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.dsh/remote/agent"
CONF_DIR="$HOME/.dsh/remote"
PLIST="$HOME/Library/LaunchAgents/com.dsh.remote.agent.plist"
LABEL="com.dsh.remote.agent"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

echo "==> 复制 agent 到 $DEST"
mkdir -p "$DEST" "$CONF_DIR"
cp "$SRC/agent/agent.js" "$SRC/agent/dsh-auth.mjs" "$SRC/agent/package.json" "$DEST/"
cd "$DEST"
if [ ! -d node_modules/ws ]; then
  npm install --omit=dev --no-audit --no-fund --silent ws@^8.18.0 qrcode@^1.5.4
fi

echo "==> 写配置"
umask 077
cat > "$CONF_DIR/config.json" <<EOF
{
  "relay": "$RELAY",
  "token": "$TOKEN",
  "upstreamHost": "127.0.0.1",
  "upstreamPort": 3081,
  "pocketPinFile": "$HOME/.dsh/dsh-pocket/token-lan"
}
EOF
chmod 600 "$CONF_DIR/config.json"

echo "==> LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST/agent.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_REMOTE_CONFIG</key><string>$CONF_DIR/config.json</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/dsh-remote.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/dsh-remote.log</string>
</dict>
</plist>
EOF
chmod 644 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
sleep 2
echo "==> 状态"
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid" | head -4 || true
tail -5 "$HOME/Library/Logs/dsh-remote.log" 2>/dev/null || true
