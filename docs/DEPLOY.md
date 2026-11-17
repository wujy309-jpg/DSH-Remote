# 部署

从零到能用，大概 20 分钟。三块：**公网服务器（relay）**、**Mac（agent）**、**手机（浏览器或安卓壳）**。

需要准备：

- 一台能上公网的 Linux 服务器（1C1G 就够，relay 常驻内存约 40–60 MB），root 或 sudo。
- 一个域名，A 记录指向这台服务器。
- 一台 Mac，上面 **DSH** 和 **[dsh-pocket](https://github.com/shaobeichen/dsh-pocket)** 都装好，
  且 `127.0.0.1:3081` 能访问到。

> 下面所有 `dsh.example.com` 都换成你自己的域名。**不要**把它们原样用上——
> `example.com` 是文档保留域名。

### 前置安装（Mac 上，本项目之外）

```bash
npm install -g @deepseek-ai/dsh              # 1. DSH 本体（若已装桌面版可跳过）
dsh --version

dsh plugin --profile web add dsh-pocket -w   # 2. dsh-pocket：移动端布局 + 握手
curl -sI http://127.0.0.1:3081 | head -1     #    应该有 HTTP 响应

cat ~/.dsh/dsh-pocket/token-lan              # 3. 局域网密码（首次运行自动生成）
```

本项目**不含**这两个东西，也不 vendor 它们的源码：relay 只搬字节，真正把手机接进 GUI 的
是 dsh-pocket。它没跑起来时，你会看到「电脑上的 DSH 没在运行 / Mac 没连上」这类提示。

> 下面所有 `dsh.example.com` 都换成你自己的域名。**不要**把它们原样用上——
> `example.com` 是文档保留域名。

---

## 一、服务器：装 relay

### 1.1 传代码并安装

```bash
# 在服务器上
git clone https://github.com/<你>/DSH-Remote.git
cd DSH-Remote

DSH_PUBLIC_BASE_URL=https://dsh.example.com bash deploy/install-relay.sh
```

脚本做的事（幂等，可以重复跑）：

| 步骤 | 结果 |
| --- | --- |
| 装 Node 运行时 | `/opt/dsh-relay/node/`（先从国内镜像取，失败回退官方源） |
| 建系统用户 | `dsh-relay`，`nologin`，home 是 `/var/lib/dsh-relay` |
| 写配置 | `/etc/dsh-relay/config.json`，权限 `600`，现场生成 `agentToken` 与 `sessionSecret` |
| 装依赖 | 只有 `ws` |
| 注册服务 | `/etc/systemd/system/dsh-relay.service`，带沙箱选项 |
| 健康检查 | `curl http://127.0.0.1:8848/__health` |

结尾会打印 `agentToken`，**记下来**：

```
==> agent token（Mac 端要填这个）
9f3c...（64 位十六进制）
```

### 1.2 配置文件长什么样

```json
{
  "port": 8848,
  "bind": "127.0.0.1",
  "publicBaseUrl": "https://dsh.example.com",
  "agentToken": "<64 位随机十六进制>",
  "sessionSecret": "<64 位随机十六进制>",
  "cookieName": "dsh_relay",
  "sessionTtlMs": 15552000000,
  "pairCodeTtlMs": 900000,
  "pairMaxAttempts": 10
}
```

| 字段 | 说明 |
| --- | --- |
| `bind` | **保持 `127.0.0.1`**。放在 `0.0.0.0` 等于把没 TLS 的入口暴露出去 |
| `publicBaseUrl` | 签给系统浏览器的一次性下载链接的前缀。留空则从 `Host` 头推 |
| `sessionTtlMs` | 手机 cookie 有效期，默认 180 天。想收紧就改小 |
| `pairCodeTtlMs` | 配对码有效期，默认 15 分钟 |
| `pairMaxAttempts` | 同一来源 IP 窗口内允许的失败次数 |

环境变量 `AGENT_TOKEN` / `SESSION_SECRET` / `PORT` / `BIND` / `PUBLIC_BASE_URL`
优先级高于配置文件。要求两个 secret 至少 24 字符，否则 relay **拒绝启动**（退出码 2）。

### 1.3 nginx + 证书

`/etc/nginx/sites-available/dsh-remote`：

```nginx
server {
    listen 80;
    server_name dsh.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    # 配对码在 URL 查询串里，日志不该成为凭据副本
    access_log off;

    # 手机上传附件走这条反代，别被默认的 1m 卡住
    client_max_body_size 64m;

    # 本机 agent 走 WSS 到 relay 时不经过这里，这些只作用于手机侧
    location / {
        proxy_pass http://127.0.0.1:8848;
        proxy_http_version 1.1;

        # WebSocket 升级（DSH 的 /api/remote.mux 需要）
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host       $host;

        # 关键：这两行必须覆盖写，否则限速可以被伪造头绕过
        proxy_set_header X-Real-IP        $remote_addr;
        proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering     off;
    }
}
```

启用并签证书：

```bash
ln -s /etc/nginx/sites-available/dsh-remote /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d dsh.example.com
certbot renew --dry-run        # 确认自动续期能跑
```

> **`X-Real-IP` 和 `X-Forwarded-For` 不要省。** relay 只信 `X-Real-IP` 和 XFF 的
> **最后一跳**；少这两行会退化成按 nginx 的地址统一限速，等于全员共用一个额度。

### 1.4 确认没有裸奔

```bash
ss -lntp | grep 8848          # 应该只看到 127.0.0.1:8848
systemctl status dsh-relay
curl -fsS http://127.0.0.1:8848/__health | python3 -m json.tool
```

---

## 二、Mac：装 agent

### 2.1 前置

- Node.js ≥ 20（`node -v` 确认；`install-agent.sh` 会用它跑常驻进程）。
- DSH 已安装并且能正常打开。
- [`dsh-pocket`](https://github.com/shaobeichen/dsh-pocket) 在 `127.0.0.1:3081` 上跑着
  （装法见本文开头的「前置安装」）。它的局域网密码文件默认在
  `~/.dsh/dsh-pocket/token-lan`，agent 用它登录 pocket；读不到也能起，
  但上游若要求鉴权会返回登录页。

### 2.2 安装

```bash
git clone https://github.com/<你>/DSH-Remote.git
cd DSH-Remote

bash deploy/install-agent.sh <agentToken> https://dsh.example.com
```

脚本会把 agent 复制到 `~/.dsh/remote/agent/`（**自包含副本**，之后挪动仓库不影响运行），
写 `~/.dsh/remote/config.json`（`600`），并注册 LaunchAgent：

| 项 | 值 |
| --- | --- |
| Label | `com.dsh.remote.agent` |
| 日志 | `~/Library/Logs/dsh-remote.log` |
| 自启 | `RunAtLoad` + `KeepAlive`（非正常退出就拉起） |
| 节流 | `ThrottleInterval` 5 秒 |

### 2.3 拿配对链接

```bash
cat ~/.dsh/remote/pair.txt          # 形如 https://dsh.example.com/__pair?code=ABCD2345
open ~/.dsh/remote/pair.png         # 二维码，手机扫它
```

配对码每次 agent 连上 relay 都会重新拿一张，用掉之后自动换新。

### 2.4 验证

```bash
launchctl print gui/$(id -u)/com.dsh.remote.agent | grep -E "state|pid"
tail -f ~/Library/Logs/dsh-remote.log
```

日志里应能看到：连上 relay、pocket 登录成功、配对码生成。

---

## 三、手机

### 3.1 用浏览器（零安装）

打开 `https://dsh.example.com`，输 8 位配对码。

想在主屏上有个图标：浏览器菜单 →「添加到主屏幕」。PWA 的 manifest 和图标是
**公开可读**的（浏览器抓取时不带 cookie，这是规范行为），里面不含任何凭据。

### 3.2 装安卓壳（想要原生文件动作才需要）

壳本身零依赖：一个全屏 WebView，不加地址栏。构建只需要 SDK + JDK，不用 Gradle。

```bash
cd android
DSH_REMOTE_HOST=dsh.example.com ./build.sh
# 产物：android/build/dsh-remote.apk
```

脚本会：渲染 `templates/` 里的域名与版本号 → `javac` → `d8` → `aapt2` → `zipalign` → `apksigner`。

**关于签名**：

- 不传 `DSH_KEYSTORE` 时会自动生成 `build/debug.keystore` 并自签——只能自己装，
  不能上架，也不能覆盖安装别人的包。
- 要长期发布就自己生成一个 keystore 并**保管好**（丢了就再也无法覆盖安装）：

```bash
keytool -genkeypair -keystore ~/keystores/dsh-remote.jks -alias dshremote \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Your Name"

DSH_REMOTE_HOST=dsh.example.com \
DSH_KEYSTORE=~/keystores/dsh-remote.jks \
DSH_KEYSTORE_ALIAS=dshremote \
DSH_KEYSTORE_PASS='<口令>' \
  ./build.sh
```

装好后第一次打开是配对页，输 8 位码即可。**App 的 cookie 和浏览器是两套**，要各配一次。

也可以用 `pair.txt` 里的链接直接打开 App（`ACTION_VIEW` 会接住并进入配对流程）。

---

## 四、可选：装「分享」插件

让手机上长按文件卡时，菜单里多一条「分享」，直接交给系统分享面板（微信 / QQ / 钉钉）。

用 DSH 的插件管理工具（`plugin_manager`）从**本地目录**安装：

```text
action: install_bundle
target: /绝对路径/DSH-Remote/share-plugin      # 必须绝对路径
```

装到 profile `desktop`，装完在 **Plugins** 里确认 `dsh-file-share`
（显示名「文件分享 / File sharing」）已启用。

注意事项：

- 本地目录安装是**链接**，不是拷贝。**别移动或删除 `share-plugin/` 目录**，否则插件失效，
  需要重新安装。想长期稳定运行，就把仓库放在一个不会挪的位置。
- 只在页面存在 `window.DSHRemote.sharePath`（也就是安卓壳里）时才显示这一项；
  桌面浏览器菜单保持原样。
- 单个文件上限 32 MB，首次分享会先下载再弹分享面板。

---

## 五、上线自检

```bash
# ① relay 冒烟 + 单元测试：本机自检，会自己起一个临时 relay 实例
#    （不需要服务器、不需要 agent；只需先 npm install 装 ws / qrcode）
node test/smoke.mjs
node --test test/mime.test.mjs test/dsh-auth.test.mjs

# ② 端到端：验的是「这次部署」，需要真实域名 + 当前有效的配对码
node test/e2e.mjs https://dsh.example.com <配对码>

# ③ 服务器侧
systemctl is-active dsh-relay
ss -lntp | grep 8848
```

`e2e.mjs` 十项全绿才算通：未配对拦截、健康检查、agent 在线、错误码拒绝、配对成功、
launch-token 握手、DSH cookie、GUI 首屏、静态资源、WebSocket。

---

## 六、更新代码

```bash
# 服务器（改了 relay）
git pull
cp relay/*.js /opt/dsh-relay/
chown dsh-relay:dsh-relay /opt/dsh-relay/*.js
systemctl restart dsh-relay

# Mac（改了 agent）—— 改完必须重启，不重启还是旧进程在跑
git pull
cp agent/agent.js agent/dsh-auth.mjs ~/.dsh/remote/agent/
launchctl kickstart -k gui/$(id -u)/com.dsh.remote.agent
```

> 「代码改了但没重启」是最常见的一类困惑：文件是新的，加载的是旧的。
> 遇到行为跟代码对不上，先 `launchctl print … | grep runs` 看进程跑了多久。
