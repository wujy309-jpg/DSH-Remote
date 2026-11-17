# 运维

日常只需要三条命令。后面是「出问题了先看哪里」的对照表。

---

## 一、日常命令

```bash
# 1. 换配对二维码（手机换了 / 码过期）
launchctl kickstart -k gui/$(id -u)/com.dsh.remote.agent && cat ~/.dsh/remote/pair.txt

# 2. 看 Mac 端日志
tail -f ~/Library/Logs/dsh-remote.log

# 3. 看服务器端日志
journalctl -u dsh-relay -f
```

## 二、状态速查

```bash
# relay 活着吗、只听 loopback 吗
systemctl status dsh-relay
ss -lntp | grep 8848

# 健康检查（服务器本机）
curl -fsS http://127.0.0.1:8848/__health | python3 -m json.tool

# agent 活着吗、跑了多久
launchctl print gui/$(id -u)/com.dsh.remote.agent | grep -E "state|pid|runs"

# 手机能不能连（从任意机器）
curl -sS -o /dev/null -w '%{http_code}\n' https://dsh.example.com/__health
```

`/__health` 的字段：

```json
{
  "ok": true,
  "agent": true,          // Mac 的 agent 是否在线
  "agentSince": 1730000000000,
  "pairPending": true,    // 当前有可用配对码
  "upstreamDown": false,  // Mac 上的 DSH 是否没在运行
  "streams": 1,           // 当前在途流数量
  "uptimeSec": 86400
}
```

这个端点**不含任何密钥**，可以放心从外网打。

---

## 三、常见操作

### 换配对码

重启 agent 就会拿新码：

```bash
launchctl kickstart -k gui/$(id -u)/com.dsh.remote.agent
cat ~/.dsh/remote/pair.txt
```

配对码默认 15 分钟过期，过期后 relay 会自动换新（agent 会收到推送并更新二维码）。

### 踢掉所有已配对的手机

改 `sessionSecret` 后重启 relay，所有 cookie 立即失效：

```bash
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

### 换 agentToken

两端都要改，否则隧道连不上：

```bash
# 服务器
python3 - <<'PY'
import json, secrets
p = "/etc/dsh-relay/config.json"
c = json.load(open(p))
c["agentToken"] = secrets.token_hex(32)
json.dump(c, open(p, "w"), indent=2)
print(c["agentToken"])
PY
systemctl restart dsh-relay

# Mac（把下面的新 token 粘进去）
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".dsh/remote/config.json"
c = json.loads(p.read_text())
c["token"] = "<新的 agentToken>"
p.write_text(json.dumps(c, indent=2))
PY
launchctl kickstart -k gui/$(id -u)/com.dsh.remote.agent
```

### 不重启 DSH 换 relay 地址

改 `~/.dsh/remote/config.json` 的 `relay` 字段，然后 `launchctl kickstart -k`。

### 清掉某个手机的 cookie

目前**没有按设备吊销**的能力（见 [`SECURITY.md`](../SECURITY.md#5-已知缺口诚实清单)），
只能换 `sessionSecret`，代价是所有设备一起失效。

---

## 四、故障对照

| 现象 | 先看哪里 | 常见原因 |
| --- | --- | --- |
| 打开是一行纯文本 `dsh web authentication required…` | `tail ~/Library/Logs/dsh-remote.log` | DSH 重启换过 token，手机的 `dsh-auth-*` 过期。v1.10 起 agent 会自己发现 401 并重放；仍出现说明**进程没重启**（文件新、加载的是旧的） |
| 显示配对页 | — | 手机 cookie 没了（换浏览器 / 清缓存 / 换 secret）→ 重新扫码 |
| 显示「Mac 现在没连上」 | `launchctl print …`、`ss -lntp \| grep 8848` | agent 挂了，或服务器停机，或 `agentToken` 两端不一致 |
| 显示「电脑上的 DSH 没在运行」 | 电脑上 DSH 是否被关掉 | 上游真的不在，relay 通过 `upstream` 帧知道了 |
| 转圈 / 白屏 | agent 日志里有没有反复重连 | relay 不回 ping 时 agent 每 75 秒自断重连，在途请求全被掐（已修）；`crypto` 版本不匹配也会 |
| 配对码不对 | 码是否超过 15 分钟 / 已被用过 | 用一次就换，需要重新 `cat pair.txt` |
| 手机上传附件失败 | nginx `client_max_body_size` | 默认 1m 太小，设成 64m |
| 点「用浏览器打开」弹出下载但链接 404 | `/etc/dsh-relay/config.json` 的 `publicBaseUrl` | 没配，且反代没带 `Host`，签出来的链接退化成相对路径 |
| 长按文件没有「分享」 | Plugins 里 `dsh-file-share` 是否启用 | 插件被停用 / `share-plugin/` 目录被挪走 / App 不是新版本 |
| APK 点开没反应、装不上 | 装的 App 是否带 `REQUEST_INSTALL_PACKAGES` | 系统「安装未知应用」没放开；安卓壳会引导跳设置 |
| 微信里没有「发送到微信」 | 手机装微信了吗 | 菜单按 `queries` 判断，没装就只显示「分享到其他应用」 |

### 日志里几个关键词

| 关键字 | 含义 |
| --- | --- |
| `[agent] 已连接` | 隧道建立成功 |
| `[pair] 配对码 ...` | 新配对码生成 |
| `上游 401` | DSH 会话失效，触发自愈重放 |
| `resend` / `abort` | 流收尾；大量 `abort` 说明有请求频繁中断 |
| `[warn] 推不出对外站点地址` | `publicBaseUrl` 没配且没有 `Host` 头 |

---

## 五、备份什么

只有一样东西值得备份：**`/etc/dsh-relay/config.json`**（里面是 `agentToken` 和 `sessionSecret`）。

丢了也能恢复——重新跑 `install-relay.sh` 会生成新的，代价是 Mac 上要重填 token、手机要重扫。

`~/.dsh/remote/config.json` 是 Mac 端的副本，重新跑 `install-agent.sh` 就能重建。

签名 keystore（如果你自己生成了）**必须单独备份**：丢了就再也无法覆盖安装同一个包，
只能让所有人卸载重装。

---

## 六、资源占用

| 组件 | 常驻内存 | 说明 |
| --- | --- | --- |
| relay | ~40–60 MB | systemd 里 `MemoryMax=192M`，超了会被杀掉重启 |
| agent | ~50 MB | 主要是 `ws` + `qrcode` |

单流缓冲上限 8 MB，超了直接掐断。`streams` 数字一直涨说明有请求没收尾，看日志里的 `abort`。
