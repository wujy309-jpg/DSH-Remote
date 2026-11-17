#!/usr/bin/env bash
# 在服务器上装 relay：Node 运行时 + 专用系统用户 + systemd 服务。
# 幂等：重复执行只会覆盖代码与配置，不会重复建用户/目录。
#
#   DSH_PUBLIC_BASE_URL=https://dsh.example.com bash deploy/install-relay.sh
#
# DSH_PUBLIC_BASE_URL 是对外站点根地址（给系统浏览器签一次性下载链接用）。
# 不配也行：relay 会从反代送来的 Host 头推。
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v22.11.0}"
PUBLIC_BASE_URL="${DSH_PUBLIC_BASE_URL:-}"
APP_DIR=/opt/dsh-relay
STATE_DIR=/var/lib/dsh-relay
CONF_DIR=/etc/dsh-relay
SERVICE_USER=dsh-relay

echo "==> 目录"
mkdir -p "$APP_DIR" "$STATE_DIR" "$CONF_DIR"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$STATE_DIR" --shell /sbin/nologin "$SERVICE_USER"

echo "==> Node 运行时"
if [ ! -x "$APP_DIR/node/bin/node" ]; then
  tmp=$(mktemp -d)
  arch=$(uname -m)
  case "$arch" in
    x86_64) node_arch=linux-x64 ;;
    aarch64|arm64) node_arch=linux-arm64 ;;
    *) echo "不支持的架构 $arch" >&2; exit 1 ;;
  esac
  tarball="node-${NODE_VERSION}-${node_arch}.tar.xz"
  ok=0
  for base in "https://npmmirror.com/mirrors/node" "https://nodejs.org/dist"; do
    echo "   下载 $base/$NODE_VERSION/$tarball"
    if curl -fsSL --max-time 180 "$base/$NODE_VERSION/$tarball" -o "$tmp/node.tar.xz"; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "Node 下载失败" >&2; exit 1; }
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  rm -rf "$APP_DIR/node"
  mv "$tmp/node-${NODE_VERSION}-${node_arch}" "$APP_DIR/node"
  rm -rf "$tmp"
fi
"$APP_DIR/node/bin/node" -v

echo "==> 配置"
if [ ! -f "$CONF_DIR/config.json" ]; then
  umask 077
  "$APP_DIR/node/bin/node" -e '
    const { randomBytes } = require("node:crypto")
    const fs = require("node:fs")
    const config = {
      port: 8848,
      bind: "127.0.0.1",
      // 对外站点根地址：给系统浏览器签一次性下载链接时用（留空则从 Host 头推）
      publicBaseUrl: process.env.DSH_PUBLIC_BASE_URL || "",
      agentToken: randomBytes(32).toString("hex"),
      sessionSecret: randomBytes(32).toString("hex"),
      cookieName: "dsh_relay",
      // 手机会话 cookie 有效期（默认 180 天）
      sessionTtlMs: 180 * 24 * 3600 * 1000,
      // 配对码有效期（默认 15 分钟）
      pairCodeTtlMs: 15 * 60 * 1000,
      // 同一来源 IP 在统计窗口内允许的失败次数
      pairMaxAttempts: 10,
    }
    fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 2))
  ' "$CONF_DIR/config.json"
  chmod 600 "$CONF_DIR/config.json"
  echo "   已生成新配置（含 agentToken / sessionSecret）"
  [ -n "$PUBLIC_BASE_URL" ] && echo "   publicBaseUrl = $PUBLIC_BASE_URL"
else
  echo "   配置已存在，保留"
fi

echo "==> 依赖"
cd "$APP_DIR"
if [ ! -d node_modules/ws ]; then
  PATH="$APP_DIR/node/bin:$PATH" npm install --omit=dev --no-audit --no-fund --silent ws@^8.18.0
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$STATE_DIR"
chmod 750 "$APP_DIR" "$STATE_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR"
chmod 750 "$CONF_DIR"
chmod 600 "$CONF_DIR/config.json"

echo "==> systemd"
cat > /etc/systemd/system/dsh-relay.service <<EOF
[Unit]
Description=DSH Remote relay (phone → Mac tunnel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=DSH_RELAY_CONFIG=$CONF_DIR/config.json
Environment=NODE_ENV=production
ExecStart=$APP_DIR/node/bin/node $APP_DIR/server.js
Restart=always
RestartSec=2
StateDirectory=dsh-relay
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
MemoryMax=192M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dsh-relay >/dev/null
systemctl restart dsh-relay
sleep 2
systemctl is-active dsh-relay
echo "==> 健康检查"
curl -fsS --max-time 5 http://127.0.0.1:8848/__health || { journalctl -u dsh-relay -n 30 --no-pager; exit 1; }
echo
echo "==> agent token（Mac 端要填这个）"
"$APP_DIR/node/bin/node" -e 'console.log(require(process.argv[1]).agentToken)' "$CONF_DIR/config.json"
