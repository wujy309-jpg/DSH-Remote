# 架构

这份文档讲**为什么长这样**，以及协议细节。想直接跑起来看 [`DEPLOY.md`](DEPLOY.md)。

---

## 1. 整体形状

```
┌────────────────┐        ┌──────────────────────┐        ┌─────────────────────────┐
│  手机浏览器/App │──TLS──►│  nginx (443)         │        │  Mac                    │
│                │  WSS   │   ↓ 127.0.0.1:8848   │        │  ┌───────────────────┐  │
│                │        │  relay               │◄──WSS──┼──│ agent             │  │
└────────────────┘        │  · 配对 / 会话 cookie │ 出站   │  └────────┬──────────┘  │
                          │  · HTTP/WS 多路复用   │        │           │ 127.0.0.1   │
                          │  · 离线页 / PWA 图标  │        │           ▼ :3081       │
                          └──────────────────────┘        │  ┌───────────────────┐  │
                                                          │  │ dsh-pocket 代理   │  │
                                                          │  └────────┬──────────┘  │
                                                          │           ▼ 随机端口    │
                                                          │  ┌───────────────────┐  │
                                                          │  │ DSH GUI           │  │
                                                          │  └───────────────────┘  │
                                                          └─────────────────────────┘
```

三个刻意的选择：

**① 隧道由电脑主动向外建立。** agent 是一个 WebSocket **客户端**，连到 relay。
这带来三个实际好处：不需要公网 IP、不用配置端口映射、换 Wi-Fi 后自己重连。
代价是「谁都能连」要由 relay 用凭据挡住，而不是靠网络边界。

**② 只搬字节，不解析。** relay 不知道你在哪个会话、发了什么消息。
它做的事就是：把一条浏览器连接映射成一个流 ID，把字节塞进与 agent 之间
那条唯一的 WSS 里，到对端再吐出来。

**③ 多绕一层 dsh-pocket。** DSH 的网页是给宽屏写的，
[dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（独立项目）已经解决了移动端布局、
Host/Origin 栅栏、launch-token 握手、压缩。relay 不重复造这些轮子。

---

## 2. 帧协议

relay 与 agent 之间**只有一条** WebSocket（`dsh-relay-v1`），上面跑两种帧：

```
文本帧 = JSON 控制帧
二进制帧 = 数据帧，头部固定 5 字节：
           [id: uint32 BE][kind: uint8][payload...]
             kind 0 = HTTP body
             kind 1 = WebSocket text 消息
             kind 2 = WebSocket binary 消息
```

5 字节头是为了让「属于哪个流」和「是什么东西」在一次读取里就能判掉，
不用维护 JSON 与二进制的交错队列。

### 控制帧一览

| `t` | 方向 | 作用 |
| --- | --- | --- |
| `hello` | relay → agent | 握手，带 `protocol` 与 `serverTime` |
| `pair` | relay → agent | 下发当前配对码与过期时间（agent 用它画二维码、写 `pair.txt`） |
| `req` | relay → agent | 新的 HTTP 请求开始（`method` / `url` / `headers`） |
| `reqend` | relay → agent | 请求体结束 |
| `res` | agent → relay | 响应头（`status` / `headers`） |
| `resend` | agent → relay | 响应体结束 |
| `abort` | 双向 | 中途取消（超时 / 客户端断开 / 请求过大） |
| `wsopen` / `wsopened` / `wsclose` | 双向 | WebSocket 隧道建立与关闭 |
| `fs` | relay → agent | 取文件（`/__fs`），agent 回 `fshead` / `fsend` / `fsfail` |
| `upstream` | agent → relay | 上游（DSH）是否在跑，用于给手机一个说得清的页面 |
| `ping` / `pong` | 双向 | 保活 |

> `ping` 这一条是补出来的。早期版本 relay 不回 agent 的 ping，agent 每 75 秒
> 自己判断超时断开重连，把在途请求全掐掉——手机上的表现就是「转圈」。
> 现在双向都回，连接是稳的。

### 背压

所有流共享同一条 WSS，所以不做逐流窗口，而是**反向暂停**：

```
any stream.buffered > threshold  →  agentSocket.pause()       (暂停读)
all streams drained             →  agentSocket.resume()      (恢复读)
```

这样大响应会让整个通道一起变慢（符合 TCP 语义），但不会把 1.8G 内存的小机器打爆。
单流缓冲另有 8 MB 硬上限，超了就 `abort`。

---

## 3. 一次请求的生命周期

```
手机                relay                       agent                  pocket/DSH
 │  GET /            │                            │                        │
 ├──────────────────►│ 没 cookie → 401 配对页     │                        │
 │                   │                            │                        │
 │  POST /__pair     │                            │                        │
 ├──────────────────►│ 比对配对码、限速、签 cookie │                        │
 │◄── 200 + cookie ──┤ 换新配对码                  │                        │
 │                   │                            │                        │
 │  GET / (有 cookie)│                            │                        │
 ├──────────────────►│ 分配 stream id = 7          │                        │
 │                   ├──── {t:"req",id:7,…} ─────►│ 改写 Host/Origin        │
 │                   │                            ├───────────────────────►│
 │                   │◄──── {t:"res",id:7,…} ─────┤◄──── 200 + Set-Cookie ─┤
 │                   │◄──── data(id=7, kind=0) ───┤◄──── body ─────────────┤
 │◄──── 200 + body ──┤◄──── {t:"resend",id:7} ────┤                        │
```

流结束时 relay 收尾、关闭 `res`；agent 侧销毁上游请求。任一端断开都会触发 `abort`，
不会留下悬挂的计时器。

---

## 4. Host / Origin 改写：鉴权单点收敛

pocket 和 DSH 都有安全栅栏：`Host` 必须是 loopback、`Origin` 必须对得上。
手机发来的 `Host` 是 `dsh.example.com`，直接透过去会被 403。

relay 与 agent 都在转发前做同一件事：

```js
headers.host = '127.0.0.1'                       // 上游只看到本机
// Origin 按 upstreamHost:port 重写
```

**这是一个有意为之的信任边界收缩。** 栅栏在 loopback 上放行，是因为**能到达 loopback
的只可能是 relay**；而 relay 只有一个入口，鉴权只在那一处做。
风险也明确：**任何能在你 Mac 上访问 `127.0.0.1:3081` 的本地进程，都绕过了鉴权**。
在单机、单人、你自己独占的电脑上，这是可接受的；多人共用机器就不成立。

---

## 5. 那个 401：DSH 重启后的自愈

这个是踩过的坑里最绕的一个，值得单独记。

**现象**：DSH 重启后，手机打开是一行纯文本
`dsh web authentication required; reopen the URL printed by dsh web.`，刷新也不恢复。

**成因链条**：

```
dsh web 进程重启 → 换了一套 tokenId
        ↓
手机里还留着 dsh-auth-<旧tokenId>=v1.xxx   （Max-Age 30 天）
        ↓
pocket 见到 Cookie 里已有 dsh-auth- 前缀 → 认为「浏览器已经握过手」
        → 不再补 ?token=<launch token>
        ↓
dsh web 对不上 token → 401
```

pocket 的判断在它自己进程里，改不了。但 **agent 是唯一入口**，可以在转发前做手脚。

**解法（`agent/dsh-auth.mjs` + `agent/agent.js`）**：

1. agent 记住第一次握手拿到的 `dsh-auth-<名字>`；
2. 转发前，把**名字对不上**的 `dsh-auth-*` 摘掉 → pocket 看不到前缀，重新握手；
3. 上游真回了 `401 text/plain` 时，**作废已学到的名字**、摘掉全部 `dsh-auth-*`，
   把这条 GET/HEAD **原样重放一次**。

第 3 步是关键。第一版只做了「名字对不上才摘」，而 DSH 重启后手机里那个旧名字
**正好等于** agent 上次学到的名字——过滤认为它对，原样放行，于是永远 401，
自己好不了（只有重启 agent 清空记忆才行）。

还有两个必须记住的实现细节：

- 重放要带 `{ ended: true }`：relay 只在第一轮发一次 `reqend`，
  新流等不到它就会永远挂着——第一版补丁就是这样把 401 变成了「一直转圈」。
- WebSocket 握手报 401 时也顺手 `reset()`，让下一次 HTTP 请求去换新 cookie。

代价：agent 刚启动（还没有记忆）时，第一次打开会多一跳过渡页。之后名字对得上就不再动。

---

## 6. 文件通道

手机要文件，有三个入口，都落在同一个地方：

```
点文件卡 / 点路径 ──► 原生动作面板（安装 / 打开 / 发微信 / 分享 / 浏览器）
长按 → 菜单「分享」──► 插件调 DSHRemote.sharePath()
网页里真正的下载 ──► setDownloadListener
        ↓
   GET /__fs?p=<绝对路径>          （带会话 cookie）
   或 GET /__fs/link?p=<路径>      （签名 5 分钟链接，给没有 cookie 的系统浏览器）
        ↓
   agent 解析路径 → 只允许工作区根目录与附件目录 → 流回手机
```

`Content-Disposition` 的规则集中在 `relay/mime.js`：

- `.apk` → `application/vnd.android.package-archive`，浏览器和系统安装器才认；
- 不可内联的类型 → `attachment`，浏览器才会下载而不是开个空白页；
- 同时给 `filename`（ASCII 兜底，保住扩展名）和 `filename*`（中文名不丢）。

这个文件是纯函数，`node --test test/mime.test.mjs` 能直接验，不用起服务。

---

## 7. 移动端排版层

DSH 网页按宽屏设计：顶栏 79px、正文 14px/24px、左右各 40px 留白。
安卓壳注入 `assets/polish.css`——**只含样式**，不改 DOM、不碰宿主、不用重启 DSH。

三个讲究：

- **不写死颜色**，只用相对值，深色模式跟随页面，不会出现白块；
- **`onPageStarted` 就注入**，head 一出现就插，慢网下不会先闪一下桌面版排版；
- **只隐藏该隐藏的**：pocket 注入的浮动抽屉按钮（图标缺 sprite，且压住「回到底部」）
  用 CSS 藏掉，页面自带的侧栏按钮照常工作。

---

## 8. 为什么不那么做

| 方案 | 为什么没选 |
| --- | --- |
| 内网穿透（frp / ngrok / Cloudflare Tunnel） | 要额外维护一个客户端和一套配置；而且鉴权最后还是得自己做。自己写 relay 反而只多 900 行 |
| 只做端口映射 | 要公网 IP，家用宽带多数没有 |
| VPN | 手机上开关 VPN 很烦，且失效时没有可解释的页面 |
| 截图流 / 远程桌面 | 交互延迟不可接受，中文输入、滚动都会崩 |
| 直接暴露 DSH 端口 + 自己的反代 | 只有一层，配对、限速、离线页、PWA、文件下载头全要重写 |
| 把 DSH 改成多租户 | 改上游不如在外面套一层；上游升级不该被我们的补丁绑住 |
