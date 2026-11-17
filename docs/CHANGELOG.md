# 变更记录

按版本倒序。每条都写**为什么改**——只写「改了什么」的记录过半年就没用了。

版本号与安卓 `versionCode` 对应。早期（v1.3–v1.5）只有内部打包，没有面向用户的变更，
这里按时间把可考的事实列出来。

---

## v1.10 · versionCode 11 · 2026-11-17

### 文件右键菜单里的「分享」

手机上的文件右键菜单（长按文件卡 / 文件引用）原来只有「打开 / 复制路径 / 下载」，
没有分享。菜单本身是 DSH Web Client 渲染的，安卓壳改不到。

**做法：写成一个 DSH 客户端插件**（`share-plugin/`，bundle 名 `dsh-file-share`）：

- Host 半是空 `apply()`，Client 半用 `ctx.contextMenus.register({ target: 'file', order: 250 })`
  在文件菜单末尾加一项「分享 / Share」，图标是内联的 share glyph（`currentColor`，跟随主题）。
- **只有页面存在 `window.DSHRemote.sharePath` 时才返回这一项**——桌面浏览器保持原菜单不变。
- 点击时插件把菜单目标（`{ sessionId, path }`）用会话的 `cwd` 解析成绝对路径，
  调 `DSHRemote.sharePath(absolute)`。

App 侧新增桥方法 `sharePath`：走 `/__fs` 取回文件（复用进度 / 取消），
然后直接 `ACTION_SEND` 弹系统分享面板——微信、QQ、钉钉都在里面。

**验证**：模拟器 Android 15 上长按文件引用 → 菜单出现 Share；点击后系统分享面板显示
`Sharing 1 file · README.md`；页面启动的插件列表里包含 `dsh-file-share/client.js`。

---

## v1.9 · versionCode 10 · 2026-11-17

### 文件动作面板 + APK 直装 + 微信分享

起因很具体：手机上点文件卡，系统「打开方式」里**没有微信**（微信只接 `ACTION_SEND`，
不接 `ACTION_VIEW`）；APK 被当成 `application/octet-stream`，安装器不认。
用户想要的其实是**能选「用浏览器打开」再装**。

- **点文件先给动作**，不再直接 `ACTION_VIEW`：
  - APK → `安装到这台手机` / `用浏览器打开` / `发送到微信` / `分享到其他应用`
  - 文本、图片、PDF、音视频 → `打开` / `发送到微信` / `分享到其他应用` / `用浏览器打开`
  - 其它二进制 → `用其他应用打开` / `发送到微信` / `分享到其他应用` / `用浏览器打开`
- **APK 直装**：`FileTypes` 把 `.apk` 认成 `application/vnd.android.package-archive`，
  下载到缓存后通过 `PreviewProvider` 的 content URI 交给系统 `PackageInstaller`。
  Manifest 加 `REQUEST_INSTALL_PACKAGES`；首次会引导去
  `ACTION_MANAGE_UNKNOWN_APP_SOURCES`，回来 `onActivityResult` 自动继续，不用再点一次。
- **微信**：`ACTION_SEND` + `EXTRA_STREAM` + `ClipData` + `FLAG_GRANT_READ_URI_PERMISSION`，
  MIME 给具体的类型（这样微信才肯收）；`<queries><package android:name="com.tencent.mm"/></queries>`
  让菜单只在装了微信时出现那一项。
- **浏览器**：`/__fs` 的响应头改对了——APK 用安装包 MIME，不可内联的类型用 `attachment`，
  中文名给 `filename*`（ASCII 兜底保住扩展名）。点「用浏览器打开」时先用中性 URL
  找到默认浏览器再按包名打开，避免「打开方式」里出现 DSH Remote 自己。
- **顺手修的**：配对链接（`/__pair?code=…`）用 `ACTION_VIEW` 打开 App 时，
  之前会忽略链接停在首页，现在会直接加载该 URL 完成配对。
- **WebView 下载兜底**：加 `setDownloadListener`，网页里真正触发下载的链接（导出日志等）
  走同一套动作面板，不再静默无反应。

**验证**（模拟器，Android 15）：动作面板截图、APK → 安装器「Update」、
Chrome 下载 54,057 字节且文件名正确、微信占位包收到 `ACTION_SEND` + content URI
并能读到 `PK` 头；relay 侧用 curl 验 `content-type` / `content-disposition` / 字节一致。

---

## v1.8 · versionCode 9 · 2026-11-16

### 任务完成提醒

- **判定**：DSH 生成时输入框主按钮 `aria-busy="true"`，结束时变回 `false`。
  用 MutationObserver 直接判定（不用 `requestAnimationFrame`——切后台会被冻结）。
- **前台**：Toast「任务已完成 · 会话名」。
- **后台**：系统通知（高优先级、震动；点通知回到 App）。Android 13+ 首次启动会请求通知权限。
- **限制**：依赖 WebView 页面还活着。App 被系统杀掉就收不到；锁屏久了也可能被冻结。
  要「锁屏也一定收到」得让前台服务自己维持一条到 relay 的连接，那是下一步的事。

---

## v1.7 · versionCode 8 · 2026-11-16

| 问题 | 做法 |
| --- | --- |
| 文件交付卡右侧「显示位置 / 用 PyCharm 打开」在手机上没用 | 整张卡可点：从预览按钮的 `title` 取绝对路径，走 `/__fs` 取回手机打开；右侧那组按钮在手机上收起 |
| 断线后页面静默，模型列表卡在 Loading | 每 8 秒轮询公开的 `/__health`：掉线显示橙色「电脑没连上 · 点此重试」，恢复后显示蓝色「网络已恢复 · 点此刷新」 |
| 冷启动白屏 | 图标 +「正在连接电脑…」过渡页，首帧出来淡出；20 秒兜底 |
| 跑长任务时手机锁屏就看不到进度 | 页面出现「停止生成」时打开 `FLAG_KEEP_SCREEN_ON`，任务结束自动释放 |
| 复制、回到底部热区偏小 | 复制按钮加 7px 透明热区；回到底部 34 → 38px |

---

## v1.6 · versionCode 7 · 2026-11-16

排版层从「注入字符串」改成 **APK assets 里的 `polish.css`**，并在 `onPageStarted`
就先挂一次（head 一出现就插），慢网下不再先闪一下桌面版排版。

| 问题 | 做法 |
| --- | --- |
| 握手层注入的浮动抽屉按钮，和页面自带的侧栏按钮重复，还盖住「自动化任务」标题和「回到底部」 | CSS 隐藏 `[data-mobile-nav="fab"]` |
| 抽屉底部「导出会话日志」是一整条灰边大药丸，看着像输入框 | 降成 30px 轻量行 + 上分隔线 |
| 浮动 📎 正好压在「回到底部」上（两按钮重叠 16×34px） | 删掉注入；DSH「+」菜单已有「文件」 |
| 慢网下先看到桌面版排版再跳成手机版 | `onPageStarted` 就注入样式 |
| 断网只看到 Chromium 的「Webpage not available」 | 原生错误页：一句人话 + 「重试」「重新配对」 |
| 深色主题下状态栏 / 导航栏仍是白条 | JS 把 `data-ds-theme-source` 推给原生，三处颜色一起换 |
| Android 返回键关不掉侧栏 | 返回时先点 `[data-mobile-nav="backdrop"]` |

---

## v1.2 · versionCode 4 · 2026-11-12

### 移动端排版层

DSH 网页是给宽屏写的：顶栏 79px、正文 14px/24px、左右各 40px 留白、状态条三个药丸
互相挤到省略号。注入一段**只含样式**的 CSS，不改 DOM、不碰宿主、不用重启 DSH。

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 顶栏 | 79px，标题被截成 10 个字 | 60px，标题完整 |
| 正文 | 14px / 24px 行高 | 15px / 1.74 行高，字距 +0.012em |
| 消息列 | 左右各 40px | 左右各 16px |
| 输入卡 | 高 130px，占位符被切到 `sessi…` | 高约 106px，占位符完整 |
| 状态条 | 三个药丸互相挤到省略号 | 10.5px、去图标，三行信息都读得全 |
| 抽屉 | 分组标题 14px、行高 32–36 | 分组标题 11.5px 大写、行更紧凑 |

**样式不写死颜色 / 底色**，深色模式跟随页面，不会出现白块。

---

## 无版本号的修复（按日期）

### 2026-11-17 · 401 的第二次修复：真·自愈

**为什么又来一次**——两个原因叠在一起：

1. **代码改了，进程没重启。** agent 从 11-12 起就没重启过（`launchctl` 里 `runs = 1`），
   11-13 写进去的过滤根本没跑起来。
2. **光「名字对不上才摘」不够。** DSH 重启后，手机里那个旧名字**正好等于** agent
   上次学到的名字，过滤认为它是对的、原样放行；pocket 见到 `dsh-auth-` 前缀又不再补
   launch token → 每次刷新都 401，自己永远好不了。

**补法**：上游回了 `401 text/plain` 就作废已学到的名字、摘掉全部 `dsh-auth-*`，
把这条 GET/HEAD **原样重放一次**。重放必须带 `{ ended: true }`——relay 只在第一轮
发一次 `reqend`，新流等不到它就会永远挂着（第一版补丁就是这样把 401 变成「一直转圈」的）。
WebSocket 握手报 401 时也顺手 `reset()`。

### 2026-11-13 · 401 的第一次修复

DSH 重启后手机白屏一行 `dsh web authentication required`。根因是 pocket 看到
`dsh-auth-` 前缀就认为「已经握过手」，不再补 launch token；而旧名字永远对不上新的 tokenId。
在 agent 转发前摘掉名字对不上的 `dsh-auth-*`，pocket 就会重新握手。
单测 9/9 + 公网复现验证。

### 2026-11-12 · relay 不回 ping 导致每 75 秒自断

agent 发 `ping`，relay 不回，agent 自己判断超时断开重连，把在途请求全掐掉——
手机上表现为「转圈」。补了 pong，双向保活。

### 2026-11-12 · 下载头

`.apk` 给 `application/vnd.android.package-archive`，不可内联的类型给 `attachment`，
中文名同时给 `filename`（ASCII 兜底）和 `filename*`。规则集中在 `relay/mime.js`，
`node --test test/mime.test.mjs` 可单独验证。

---

## 发布到本仓库时做的调整

把内部工程整理成可以公开的形态：

- **去掉所有站点标识**：域名、公网 IP、SSH 端口全部移除。安卓的域名改成构建期
  由 `DSH_REMOTE_HOST` 注入（`templates/` + `build.sh` 渲染），源码里不再出现具体域名。
- **安卓包名改为 `dev.dshremote.app`**（原包名里带个人域名）。
- **签名密钥不入库**：`build.sh` 从 `DSH_KEYSTORE` 读，没有就现生成调试密钥。
- **`publicBaseUrl` 可配置**：relay 不再硬编码对外地址，优先取配置，其次从 `Host` 头推。
- **配对码默认有效期统一为 15 分钟**（此前安装脚本里写的是 24 小时，与文档不一致）。
- **补齐自检**：新增 `test/smoke.mjs`（20 项安全栅栏，本机临时起 relay，不需要服务器和 agent）；
  既有的下载头 / cookie 过滤单测保留，`e2e.mjs` 保留为真实部署后的验收脚本。
- **剔除第三方代码与派生产物**：`dsh-pocket` 等参考实现不再 vendor，改为链接引用；
  真实会话截图、构建产物、依赖目录一律不进版本库。
