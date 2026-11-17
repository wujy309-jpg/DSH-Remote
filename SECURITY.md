# 安全策略

DSH Remote 把一台**能执行任意代码的电脑**的完整 GUI 暴露到公网上。它的安全性取决于
三件事：配对凭据怎么发、隧道怎么鉴权、服务器暴露面有多大。这份文档把这三件事讲清楚，
并且把**已知缺口**也列出来——不藏着。

---

## 1. 威胁模型

### 假设你能控制

- 一台你独占的公网服务器（relay），以及它的 nginx / 证书 / systemd。
- 你的 Mac，以及上面跑的 DSH 与 dsh-pocket。
- 配对码、`agentToken`、`sessionSecret` 这些凭据的分发渠道。

### 假设你不信任

- 公网上的任何人（包括扫描器和撞码机器人）。
- 手机所在的网络——咖啡馆 WiFi、运营商、公司网关都可能是中间人。
- 手机本身：**手机丢了 = 凭据丢了**，见第 5 节。
- 浏览器扩展、WebView 里被注入的内容。

### 明确的非目标

- 不是多用户系统。一个 relay 只服务一条 agent 连接、一个使用者。
- 不做端到端加密：TLS 在 nginx 终止，relay 看得见明文流量。如果你连服务器运维方
  都不信任，这套模型不适用。
- 不做审计日志与合规留存（日志默认关，配对码本来就不该落盘）。

---

## 2. 三层凭据

| 凭据 | 谁持有 | 有效期 | 泄露后果 | 怎么轮换 |
| --- | --- | --- | --- | --- |
| `agentToken` | relay 与 Mac agent | 长期 | 别人能顶掉你的 agent 连接，把隧道指向别处 | 改 `config.json` 后重启两端 |
| 配对码 | 屏幕上 / `pair.txt` | 默认 15 分钟，用掉即换 | 别人能换到一个长期 cookie | 重启 agent 换新码 |
| 会话 cookie | 手机浏览器 | 默认 180 天 | **等于那台 Mac 的控制权** | 换 `sessionSecret` 让所有手机失效 |

设计上刻意让 token **走 WebSocket 子协议**（`auth.<token>`）而不是 URL：
URL 会进 access log、Referer、浏览器历史，子协议头不会。

---

## 3. 服务器暴露面

```
公网 443  →  nginx（TLS 终止、certbot 续期）  →  127.0.0.1:8848 relay
```

- relay **只监听 loopback**（`BIND=127.0.0.1`）。少一步反代就什么都连不上，不会裸奔。
- 站点 `access_log off`：配对码在 URL 查询串里，日志不该变成凭据副本。
- systemd 单元带 `NoNewPrivileges` / `ProtectSystem=strict` / `ProtectHome` /
  `PrivateTmp` / `MemoryMax=192M`，被拿下也拿不到多少东西。
- 下载链接用 HMAC 签名，5 分钟过期，只对单个路径有效——因为系统浏览器没有我们的 cookie。

### 反代必须做的两件事

1. **覆盖 `X-Real-IP`**（`proxy_set_header X-Real-IP $remote_addr`）。
   限速靠它，客户端伪造无效。
2. **别把 `X-Forwarded-For` 当第一段用**。relay 只信**最后一跳**，
   因为 `$proxy_add_x_forwarded_for` 会把你客户端自带的假 IP 拼在最前面。

早期版本取过第一段，等于把限速开关交给攻击者——换一个伪造头就绕过，已修。

---

## 4. 应用层栅栏

| 位置 | 栅栏 |
| --- | --- |
| 未配对访问 `/` | 401 + 配对引导页，**不下发任何 GUI 内容** |
| 配对失败 | 401/429，**不发 cookie** |
| 配对限速 | 同来源 IP 窗口内最多 `pairMaxAttempts`（默认 10）次失败；全局窗口内失败过多则暂停配对一段时间 |
| `/__fs` | 两条准入路径（会话 cookie / 一次性签名）都必须先过；路径只在工作区根与附件目录内解析，越界 404 |
| `PreviewProvider`（安卓） | `exported=false`、只读、限定在 `cacheDir/previews`，`getCanonicalPath` 校验不越界 |
| 安卓 WebView | `usesCleartextTraffic=false`；站外链接交给系统浏览器，不在壳里加载 |
| 插件 | `dsh-file-share` 只在页面存在 `window.DSHRemote.sharePath` 时显示菜单项 |

`test/smoke.mjs` 把这些栅栏都断言了一遍，改代码后跑一次就知道有没有破。

---

## 5. 已知缺口（诚实清单）

| 缺口 | 影响 | 缓解 |
| --- | --- | --- |
| **会话 cookie 不能按设备吊销** | 手机丢了只能换 `sessionSecret`，所有手机一起重新配对 | 见下方「立刻踢掉所有手机」；做单设备白名单是后续工作 |
| cookie 有效期 180 天 | 拿到 cookie 的人可以长期用 | 缩短 `sessionTtlMs`；或换 secret |
| 没有二次验证 | 配对码泄露即失守 | 配对码只走可信渠道（当面扫、自己看）；别截图发群里 |
| TLS 在 relay 终止 | 服务器运维方能看到明文 | 信任模型内接受；要更强就自己加一层 |
| 安卓壳 cookie 与浏览器 cookie 是两套 | 需要各配一次 | 设计如此，不是漏洞 |
| 后台任务提醒依赖 WebView 存活 | App 被系统杀掉就收不到 | 系统通知只是尽力而为，不是可靠推送 |
| 第三方依赖只有 `ws` / `qrcode` | 依赖面很小，但仍应定期 `npm audit` | `npm audit --omit=dev` |

### 立刻踢掉所有已配对的手机

```bash
# 在服务器上：换掉 sessionSecret 后重启 relay，所有手机 cookie 立即失效
python3 - <<'PY'
import json, secrets
p = "/etc/dsh-relay/config.json"
c = json.load(open(p))
c["sessionSecret"] = secrets.token_hex(32)
json.dump(c, open(p, "w"), indent=2)
PY
chmod 600 /etc/dsh-relay/config.json
systemctl restart dsh-relay
```

换 `agentToken` 同理，但要同时更新 Mac 上的 `~/.dsh/remote/config.json` 并重启 agent。

---

## 6. 部署自检清单

上线前逐条打勾：

- [ ] relay 的 `BIND` 是 `127.0.0.1`，`ss -lntp | grep 8848` 看不到 `0.0.0.0`
- [ ] `/etc/dsh-relay/config.json` 权限 `600`，属主是服务用户
- [ ] 站点开了 `access_log off`，且确认没有别的日志组件把查询串写下来
- [ ] nginx 覆盖写 `X-Real-IP $remote_addr`
- [ ] 证书自动续期（`certbot renew --dry-run` 通过）
- [ ] 手机用 4G（不连家里 WiFi）能打开，说明不走内网地址
- [ ] `node test/smoke.mjs` 全绿
- [ ] `git status` 里没有任何 `*.keystore`、`config.json`、`pair.txt`

---

## 7. 报告问题

这是一个自托管工具，没有托管服务也没有赏金计划。发现漏洞请**不要**开公开 issue，
用 GitHub 的 Security Advisory（仓库 **Security → Report a vulnerability**）私下说明，
或者在 issue 里只描述影响范围、约一个私下渠道。

请附上：影响版本（`git log -1`）、复现步骤、你判断的影响面。
涉及「拿到 shell」级别的，请务必先确认对端是你自己的测试环境。
