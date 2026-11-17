package dev.dshremote.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * DSH Remote 的安卓壳。
 *
 * 除了「全屏 WebView」之外，它补了 DSH 网页在手机上缺的几件事：
 *   1. 分享：微信/QQ 里「分享 → DSH Remote」把文件塞进来，自动附到对话框。
 *   2. 文件：点聊天里的文件路径/文件卡，App 从电脑把文件取回来，再给一个动作面板
 *      （APK：直接安装 / 用浏览器打开；其它：打开、发送到微信、分享到其他应用、用浏览器打开）。
 *      网页默认只会「在电脑上打开」，人不在电脑前等于没用；而系统「打开方式」里
 *      既没有微信，也不一定能把 APK 装起来，所以这里把动作显式列出来。
 *   3. 排版：assets/polish.css 在首帧前注入；改样式只改那一个文件。
 *   4. 状态栏跟随页面主题；断网时给一张能重试的原生错误页。
 *
 * 注：v1.6 起不再注入 📎 浮动按钮——DSH 的「+」菜单已经有「文件」，
 * 而那个按钮固定压在「回到底部」上，反而挡路。
 */
public class MainActivity extends Activity {

  /**
   * 站点域名。构建时由 {@code build.sh} 从环境变量 {@code DSH_REMOTE_HOST} 写进
   * {@code BuildConfig.HOST}，源码里不写死任何一个具体域名。
   */
  private static final String HOST = BuildConfig.HOST;

  private static final String HOST_SUFFIX = "." + HOST;
  private static final String START_URL = "https://" + HOST + "/";
  private static final int FILE_CHOOSER_REQUEST = 1001;
  private static final int INSTALL_PERMISSION_REQUEST = 1002;
  private static final String WECHAT_PACKAGE = "com.tencent.mm";
  private static final String APK_MIME = "application/vnd.android.package-archive";

  /** 移动端排版层：从 assets/polish.css 读取（改样式只改那一个文件）。 */
  private String polishCss = "";

  private WebView web;
  private ProgressBar progress;
  private android.webkit.ValueCallback<Uri[]> filePathCallback;

  /** 连不上电脑时盖在 WebView 上的原生页（带「重试」「重新配对」）。 */
  private View errorLayer;
  private TextView errorTitle;
  private TextView errorDetail;

  /** 页面当前是否深色；状态栏 / 导航栏 / WebView 底色都跟着它走。 */
  private boolean dark = false;

  /** 主文档加载失败时，onPageFinished 仍会来（Chromium 自己的错误页），别把错误层又关掉。 */
  private boolean mainFrameFailed = false;

  /** 从别的 App 分享进来的文件，等网页下一次要文件时直接交出去。 */
  private final List<Uri> sharedFiles = new ArrayList<>();

  /** 文件动作面板 / 取回进度 / 等用户去开「安装未知应用」的那个 APK。 */
  private Dialog fileSheet;
  private Dialog downloadDialog;
  private ProgressBar downloadBar;
  private TextView downloadLabel;
  private volatile HttpURLConnection activeDownload;
  private volatile boolean downloadCancelled;
  private Source pendingInstallSource;
  private File pendingInstallFile;

  private long lastBackAt = 0L;

  private static final int LIGHT_BG = 0xFFFFFFFF;
  private static final int DARK_BG = 0xFF0F1115;
  private static final long HEALTH_INTERVAL_MS = 8000L;
  private static final String CHANNEL_ID = "task_done";
  private static final int NOTIFY_ID = 2048;
  private static final int NOTIFY_PERMISSION_REQUEST = 2049;

  /** 页面在前台时用 Toast，切后台才发系统通知。 */
  private boolean foreground = false;

  /** 首次进入时的过渡页；页面首帧出来就淡出。 */
  private View splashView;
  private long splashAt = 0L;
  private boolean splashDone = false;

  /** 「电脑没连上」的细横幅：WebSocket 静默掉线时也能被看见。 */
  private TextView offlineBanner;
  private boolean healthDown = false;

  private final Handler ui = new Handler(Looper.getMainLooper());
  private ExecutorService healthIo;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    polishCss = readAsset("polish.css");
    dark = isSystemDark();

    Window window = getWindow();
    applyBars(dark);
    setupNotifications();

    FrameLayout root = new FrameLayout(this);

    web = new WebView(this);
    WebView.setWebContentsDebuggingEnabled(
        (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(true);

    CookieManager cookies = CookieManager.getInstance();
    cookies.setAcceptCookie(true);
    cookies.setAcceptThirdPartyCookies(web, true);

    web.setBackgroundColor(dark ? DARK_BG : LIGHT_BG);
    web.addJavascriptInterface(new Bridge(), "DSHRemote");

    // 网页里真正触发下载的链接（导出日志、附件等）：WebView 默认什么都不做，
    // 这里接住，走和「点文件卡」同一套动作面板。
    web.setDownloadListener(
        (url, userAgent, contentDisposition, mimeType, contentLength) ->
            onWebDownload(url, contentDisposition, mimeType));

    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String host = uri.getHost();
            if (host != null && isOurHost(host)) return false;
            try {
              startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
              // 没有可用浏览器就忽略
            }
            return true;
          }

          @Override
          public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            mainFrameFailed = false;
            hideError();
            // 首帧前就补一次样式：等 onPageFinished 再注入，慢网下会先闪一下桌面版排版。
            injectEarlyPolish();
          }

          @Override
          public void onPageCommitVisible(WebView view, String url) {
            hideSplash();
          }

          @Override
          public void onPageFinished(WebView view, String url) {
            injectPolish();
            injectThemeSync();
            injectBusyWatch();
            injectDoneWatch();
            injectHelpers();
            maybeDeliverSharedFiles();
            hideSplash();
            if (!mainFrameFailed) hideError();
          }

          @Override
          public void onReceivedError(
              WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame()) return;
            mainFrameFailed = true;
            hideSplash();
            showError(friendlyError(error));
          }
        });

    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public void onProgressChanged(WebView view, int newProgress) {
            if (progress == null) return;
            progress.setProgress(newProgress);
            progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
          }

          @Override
          public boolean onShowFileChooser(
              WebView view,
              android.webkit.ValueCallback<Uri[]> callback,
              FileChooserParams params) {
            // 分享进来的文件优先：不再弹选择器，直接把文件交给网页
            if (!sharedFiles.isEmpty()) {
              callback.onReceiveValue(sharedFiles.toArray(new Uri[0]));
              sharedFiles.clear();
              toast("已附加分享的文件");
              return true;
            }
            filePathCallback = callback;
            try {
              startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
              return true;
            } catch (Exception e) {
              filePathCallback = null;
              return false;
            }
          }
        });

    root.addView(
        web,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    root.addView(
        progress, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 6));

    offlineBanner = buildOfflineBanner();
    root.addView(
        offlineBanner,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(36), Gravity.TOP));

    errorLayer = buildErrorLayer();
    root.addView(
        errorLayer,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    splashView = buildSplash();
    splashAt = SystemClock.uptimeMillis();
    // 兜底：首屏一直没 commit 也不要把人锁在过渡页里
    ui.postDelayed(this::hideSplash, 20000);
    root.addView(
        splashView,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    setContentView(root);

    handleShare(getIntent());

    // 从二维码/系统浏览器点配对链接进来时，直接加载这一次的 URL（带 code），
    // 否则会停在首页、把配对码丢掉。
    String deepLink = viewUrl(getIntent());
    if (savedInstanceState != null) {
      web.restoreState(savedInstanceState);
    } else {
      web.loadUrl(deepLink == null ? START_URL : deepLink);
    }
  }

  // ------------------------------------------------------------------ 分享

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handleShare(intent);
    String deepLink = viewUrl(intent);
    if (deepLink != null && web != null) web.loadUrl(deepLink);
  }

  /** ACTION_VIEW 且是本域名的链接 → 返回要加载的 URL；否则 null。 */
  private static String viewUrl(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return null;
    Uri data = intent.getData();
    if (data == null || !"https".equals(data.getScheme())) return null;
    String host = data.getHost();
    if (host == null || !isOurHost(host)) return null;
    return data.toString();
  }

  /** 本站域名或它的子域。 */
  private static boolean isOurHost(String host) {
    return host.equals(HOST) || host.endsWith(HOST_SUFFIX);
  }

  private void handleShare(Intent intent) {
    if (intent == null) return;
    String action = intent.getAction();
    if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;

    List<Uri> incoming = new ArrayList<>();
    if (Intent.ACTION_SEND.equals(action)) {
      Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (one != null) incoming.add(one);
    } else {
      ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
      if (many != null) incoming.addAll(many);
    }
    if (incoming.isEmpty()) {
      toast("没收到文件");
      return;
    }

    int flags = intent.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION);
    for (Uri uri : incoming) {
      try {
        getContentResolver().takePersistableUriPermission(uri, flags);
      } catch (Exception ignored) {
        // 很多分享来源不给持久授权，只要本次能读就行
      }
    }
    sharedFiles.clear();
    sharedFiles.addAll(incoming);
    toast(incoming.size() == 1 ? "文件已接收，正在附到对话框…" : "已接收 " + incoming.size() + " 个文件");

    if (web != null) {
      web.post(() -> web.evaluateJavascript(
          "(function(){try{var i=document.querySelector('input[type=file]');if(i){i.click();return 'ok'}return 'no-input'}catch(e){return 'err'}})()",
          null));
    }
  }

  // ------------------------------------------------------------------ 注入

  /** 注入移动端排版层（幂等）：只改字号/行高/留白/圆角，不动 DOM 结构。 */
  private void injectPolish() {
    if (web == null || polishCss.isEmpty()) return;
    String js =
        "(function(){"
            + "var s=document.getElementById('dshx-style');"
            + "if(!s){if(!document.head)return;"
            + "s=document.createElement('style');s.id='dshx-style';"
            + "document.head.insertBefore(s,document.head.firstChild);}"
            + "if(s.textContent)return;"
            + "s.textContent="
            + org.json.JSONObject.quote(polishCss)
            + ";"
            + "})();";
    web.evaluateJavascript(js, null);
  }

  /** 首帧前就挂样式：head 一出现就插，慢网下不再先闪一下桌面版排版。 */
  private void injectEarlyPolish() {
    if (web == null || polishCss.isEmpty()) return;
    String js =
        "(function(){"
            + "if(window.__dshxEarly)return;window.__dshxEarly=true;"
            + "var css="
            + org.json.JSONObject.quote(polishCss)
            + ";"
            + "function put(){"
            + "  if(!document.head)return setTimeout(put,20);"
            + "  var s=document.getElementById('dshx-style');"
            + "  if(!s){s=document.createElement('style');s.id='dshx-style';"
            + "    document.head.insertBefore(s,document.head.firstChild);}"
            + "  if(!s.textContent)s.textContent=css;"
            + "}"
            + "put();"
            + "})();";
    web.evaluateJavascript(js, null);
  }

  /** 页面主题变了就同步状态栏/导航栏/WebView 底色（深色模式不再留一条白边）。 */
  private void injectThemeSync() {
    if (web == null) return;
    String js =
        "(function(){"
            + "function mode(){"
            + "  var d=document.documentElement.getAttribute('data-ds-theme-source');"
            + "  if(d==='dark'||d==='light')return d;"
            + "  try{if(matchMedia('(prefers-color-scheme: dark)').matches)return 'dark';}catch(e){}"
            + "  return 'light';"
            + "}"
            + "function push(){try{DSHRemote.setTheme(mode());}catch(e){}}"
            + "if(!window.__dshxTheme){window.__dshxTheme=true;"
            + "  try{new MutationObserver(push).observe(document.documentElement,"
            + "    {attributes:true,attributeFilter:['data-ds-theme-source','class','style']});}catch(e){}"
            + "  try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',push);}catch(e){}"
            + "}"
            + "push();"
            + "})();";
    web.evaluateJavascript(js, null);
  }

  /** 点文件路径：拦下来交给 App 自己取回打开（网页默认只会「在电脑上打开」）。 */
  private void injectHelpers() {
    String script =
        "(function(){"
            + "if(window.__dshRemoteHooked)return;window.__dshRemoteHooked=true;"
            // 不能用 closest('code,a') 找——DSH 把路径画在段落里的一个 span 里，
            // 点击目标往往是整段 <p>。改用「手指落点处的文本节点」，命中率最高。
            + "var re=/([\\w./@~-]*\\/[\\w.@~\\u4e00-\\u9fa5-]+\\.[A-Za-z0-9]{1,6})|^([\\w.@~\\u4e00-\\u9fa5-]+\\.[A-Za-z0-9]{1,6})$/;"
            + "function isPath(t){if(!t||t.length>200)return null;if(/^https?:\\/\\//.test(t))return null;var m=t.match(re);if(!m)return null;var v=(m[1]||m[2]||'').trim();if(!v||/^[0-9.]+$/.test(v))return null;return v;}"
            // 文件交付卡：title 里就是绝对路径，直接取回手机打开（不再走「在电脑上打开」）
            + "function cardPath(t){try{var card=t&&t.closest?t.closest('[data-presented-file]'):null;"
            + "  if(!card)return null;var b=card.querySelector('button[title^=\"/\"]');"
            + "  var p=b&&b.getAttribute('title');return p&&p.charAt(0)==='/'?p:null;}catch(e){return null}}"
            + "document.addEventListener('click',function(e){"
            + "  var t=e.target;"
            + "  if(t&&t.closest&&t.closest('button[aria-haspopup=\"menu\"]'))return;"
            + "  var cp=cardPath(t);if(!cp)return;"
            + "  e.preventDefault();e.stopImmediatePropagation();DSHRemote.openPath(cp);"
            + "},true);"
            + "document.addEventListener('click',function(e){"
            + "  var path=null;"
            + "  try{var r=document.caretRangeFromPoint?document.caretRangeFromPoint(e.clientX,e.clientY):null;"
            + "      var n0=r&&r.startContainer;if(n0&&n0.nodeType===3){path=isPath((n0.textContent||'').trim());}}catch(err){}"
            + "  if(!path){var el=e.target;for(var i=0;i<3&&el;i++){var t=(el.textContent||'').trim();if(t.length<200){path=isPath(t);if(path)break;}el=el.parentElement;}}"
            + "  if(!path)return;"
            + "  e.preventDefault();e.stopPropagation();"
            + "  DSHRemote.openPath(path);"
            + "},true);"
            + "})();";
    web.evaluateJavascript(script, null);
  }

  /** 任务在跑的时候保持亮屏（页面出现「停止生成」时打开，结束后关掉）。 */
  private void injectBusyWatch() {
    if (web == null) return;
    String js =
        "(function(){"
            + "if(window.__dshxBusy)return;window.__dshxBusy=true;"
            + "var last=null;"
            + "function busy(){try{return !!document.querySelector("
            + "  'button[aria-label*=\"停止\"],button[aria-label^=\"Stop\"]');}catch(e){return false}}"
            + "function push(){var b=busy();if(b!==last){last=b;try{DSHRemote.setBusy(b);}catch(e){}}}"
            + "var pending=false;"
            + "function schedule(){if(pending)return;pending=true;requestAnimationFrame(function(){pending=false;push();});}"
            + "try{new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-label']});}catch(e){}"
            + "push();"
            + "})();";
    web.evaluateJavascript(js, null);
  }

  private void maybeDeliverSharedFiles() {
    if (sharedFiles.isEmpty()) return;
    web.evaluateJavascript(
        "(function(){try{var i=document.querySelector('input[type=file]');if(i){i.click();return 'ok'}return 'no'}catch(e){return 'err'}})()",
        null);
  }

  // ------------------------------------------------------------------ 文件

  /**
   * 网页侧桥：打开文件 / 同步主题 / 弹提示。
   *
   * 点文件不再「默认拿一个 App 打开」——先给动作面板，见 {@link #openFileSheet(String)}。
   */
  private class Bridge {
    @JavascriptInterface
    public void openPath(String path) {
      runOnUiThread(() -> openFileSheet(path));
    }

    /**
     * 网页右键菜单里的「分享」：取回文件后直接弹系统分享面板，不再经过动作面板。
     *
     * <p>菜单由 DSH 的 `dsh-file-share` 客户端插件添加；插件会先把它解析成绝对路径。
     */
    @JavascriptInterface
    public void sharePath(String path) {
      runOnUiThread(
          () -> {
            String value = path == null ? "" : path.trim();
            if (value.isEmpty()) return;
            String name = value.substring(value.lastIndexOf('/') + 1);
            if (name.isEmpty()) name = "file";
            Source source = new Source(value, null, name, null);
            withFile(source, file -> shareFile(source, file, null));
          });
    }

    @JavascriptInterface
    public void setTheme(String mode) {
      runOnUiThread(() -> applyBars("dark".equals(mode)));
    }

    @JavascriptInterface
    public void taskDone(String title) {
      runOnUiThread(() -> onTaskDone(title));
    }

    @JavascriptInterface
    public void setBusy(boolean busy) {
      runOnUiThread(
          () -> {
            if (busy) {
              getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
              getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
          });
    }

    @JavascriptInterface
    public void toast(String message) {
      MainActivity.this.toast(message);
    }
  }

  /** 一个文件：来自电脑路径（path）或网页下载链接（url），取回后落到 local。 */
  private static final class Source {
    final String path;
    final String url;
    final String name;
    final String mime;
    File local;

    Source(String path, String url, String name, String mime) {
      this.path = path;
      this.url = url;
      this.name = name == null || name.isEmpty() ? "file" : name;
      this.mime = mime == null || mime.isEmpty() ? FileTypes.mimeOf(this.name) : mime;
    }
  }

  private interface FileCallback {
    void onFile(File file);
  }

  /** 点聊天里的文件卡/文件路径：先列动作，再决定取回、安装还是交给浏览器。 */
  private void openFileSheet(String rawPath) {
    String path = rawPath == null ? "" : rawPath.trim();
    if (path.isEmpty()) return;
    String name = path.substring(path.lastIndexOf('/') + 1);
    if (name.isEmpty()) name = "file";
    showFileSheet(new Source(path, null, name, null));
  }

  /**
   * 文件动作面板。
   *
   * <p>系统「打开方式」有两个硬伤：APK 被当成 octet-stream（安装器不认），以及微信根本
   * 不在 VIEW 列表里。这里按文件类型把动作显式列出来，微信走 ACTION_SEND，APK 走安装器。
   */
  private void showFileSheet(Source source) {
    dismissSheet();
    final FileTypes.Kind kind = FileTypes.kindOf(source.name);

    LinearLayout card = new LinearLayout(this);
    card.setOrientation(LinearLayout.VERTICAL);
    card.setPadding(dp(20), dp(16), dp(20), dp(8));
    card.setBackground(rounded(dark ? 0xFF1A1E26 : 0xFFFFFFFF, 20));

    TextView title = new TextView(this);
    title.setText(source.name);
    title.setTextSize(15.5f);
    title.setTypeface(null, android.graphics.Typeface.BOLD);
    title.setTextColor(dark ? 0xFFE9EEF7 : 0xFF16181D);
    title.setMaxLines(2);
    title.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
    card.addView(title);

    TextView meta = new TextView(this);
    meta.setText(FileTypes.label(kind) + " · " + source.mime);
    meta.setTextSize(12f);
    meta.setSingleLine(true);
    meta.setEllipsize(android.text.TextUtils.TruncateAt.END);
    meta.setTextColor(dark ? 0xFF8B93A1 : 0xFF7A8088);
    LinearLayout.LayoutParams metaParams =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    metaParams.topMargin = dp(3);
    metaParams.bottomMargin = dp(10);
    card.addView(meta, metaParams);

    if (kind == FileTypes.Kind.APK) {
      // 用户要的正是这两条：要么直接装，要么去浏览器里装。
      addSheetRow(
          card,
          "安装到这台手机",
          "调用系统安装器；第一次要允许「安装未知应用」",
          true,
          () -> withFile(source, file -> installApk(source, file)));
      if (source.path != null) {
        addSheetRow(
            card, "用浏览器打开", "交给浏览器下载，下载完在浏览器通知里点安装", false, () -> openInBrowser(source));
      }
      if (wechatInstalled()) {
        addSheetRow(
            card,
            "发送到微信",
            "转发给好友 / 文件传输助手",
            false,
            () -> withFile(source, file -> shareToWechat(source, file)));
      }
      addSheetRow(
          card,
          "分享到其他应用",
          "QQ、钉钉、邮箱…",
          false,
          () -> withFile(source, file -> shareFile(source, file, null)));
    } else {
      if (FileTypes.previewable(kind)) {
        addSheetRow(
            card,
            "打开",
            FileTypes.label(kind) + " · 用系统查看器",
            true,
            () -> withFile(source, file -> viewFile(source, file)));
      } else {
        addSheetRow(
            card,
            "用其他应用打开",
            "交给系统「打开方式」选一个 App",
            true,
            () -> withFile(source, file -> viewWithChooser(source, file)));
      }
      if (wechatInstalled()) {
        addSheetRow(
            card,
            "发送到微信",
            "转发给好友 / 文件传输助手",
            false,
            () -> withFile(source, file -> shareToWechat(source, file)));
      }
      addSheetRow(
          card,
          "分享到其他应用",
          "QQ、钉钉、邮箱…",
          false,
          () -> withFile(source, file -> shareFile(source, file, null)));
      if (source.path != null) {
        addSheetRow(card, "用浏览器打开", "浏览器里下载 / 预览", false, () -> openInBrowser(source));
      }
    }

    Button cancel = styledButton("取消", false);
    cancel.setOnClickListener(v -> dismissSheet());
    LinearLayout.LayoutParams cancelParams =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    cancelParams.topMargin = dp(4);
    card.addView(cancel, cancelParams);

    FrameLayout wrap = new FrameLayout(this);
    wrap.setPadding(dp(10), dp(10), dp(10), dp(14));
    wrap.addView(
        card,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    Dialog dialog = new Dialog(this);
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
    dialog.setContentView(wrap);
    dialog.setCanceledOnTouchOutside(true);
    dialog.setOnDismissListener(d -> {
      if (fileSheet == dialog) fileSheet = null;
    });
    Window window = dialog.getWindow();
    if (window != null) {
      window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
      window.setGravity(Gravity.BOTTOM);
      WindowManager.LayoutParams params = window.getAttributes();
      params.width = WindowManager.LayoutParams.MATCH_PARENT;
      params.height = WindowManager.LayoutParams.WRAP_CONTENT;
      params.dimAmount = 0.42f;
      window.setAttributes(params);
      window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
    }
    fileSheet = dialog;
    dialog.show();
  }

  private void addSheetRow(
      LinearLayout card, String title, String hint, boolean primary, Runnable action) {
    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.VERTICAL);
    row.setPadding(dp(6), dp(11), dp(6), dp(11));
    applyRipple(row);

    TextView label = new TextView(this);
    label.setText(title);
    label.setTextSize(15f);
    label.setTextColor(
        primary ? (dark ? 0xFF7EA6FF : 0xFF2563EB) : (dark ? 0xFFE9EEF7 : 0xFF16181D));
    row.addView(label);

    if (hint != null && !hint.isEmpty()) {
      TextView sub = new TextView(this);
      sub.setText(hint);
      sub.setTextSize(12f);
      sub.setTextColor(dark ? 0xFF8B93A1 : 0xFF7A8088);
      LinearLayout.LayoutParams params =
          new LinearLayout.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
      params.topMargin = dp(2);
      row.addView(sub, params);
    }

    row.setOnClickListener(
        v -> {
          dismissSheet();
          action.run();
        });
    card.addView(row);
  }

  private void applyRipple(View view) {
    int[] attrs = new int[] {android.R.attr.selectableItemBackground};
    android.content.res.TypedArray typed = obtainStyledAttributes(attrs);
    int res = typed.getResourceId(0, 0);
    typed.recycle();
    if (res != 0) view.setBackgroundResource(res);
  }

  private GradientDrawable rounded(int color, int radiusDp) {
    GradientDrawable background = new GradientDrawable();
    background.setColor(color);
    background.setCornerRadius(dp(radiusDp));
    return background;
  }

  private void dismissSheet() {
    Dialog dialog = fileSheet;
    fileSheet = null;
    if (dialog != null) {
      try {
        dialog.dismiss();
      } catch (Exception ignored) {
        // 已经关了
      }
    }
  }

  // ------------------------------------------------------------------ 取回文件

  private void withFile(Source source, FileCallback callback) {
    if (source.local != null && source.local.exists()) {
      callback.onFile(source.local);
      return;
    }
    downloadSource(source, callback);
  }

  /** 把文件从电脑（或网页给的下载链接）取回缓存目录，带进度和取消。 */
  private void downloadSource(Source source, FileCallback callback) {
    downloadCancelled = false;
    showDownloadProgress(source.name);

    new Thread(
            () -> {
              HttpURLConnection connection = null;
              File out = null;
              try {
                String address =
                    source.url != null
                        ? source.url
                        : "https://" + HOST + "/__fs?p=" + URLEncoder.encode(source.path, "UTF-8");
                connection = (HttpURLConnection) new URL(address).openConnection();
                activeDownload = connection;
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(60000);
                String cookie = CookieManager.getInstance().getCookie("https://" + HOST + "/");
                if (cookie != null) connection.setRequestProperty("Cookie", cookie);

                int status = connection.getResponseCode();
                if (status == 401) {
                  hideDownloadProgress();
                  toast("登录已失效，重新配对一下");
                  return;
                }
                if (status != 200) {
                  String body = readAll(connection.getErrorStream());
                  hideDownloadProgress();
                  toast("取不到文件：" + (body.isEmpty() ? ("HTTP " + status) : shorten(body)));
                  return;
                }

                long total = connection.getContentLengthLong();
                File dir = PreviewProvider.previewDir(this);
                out = new File(dir, safeName(source.name));
                try (InputStream in = connection.getInputStream();
                    FileOutputStream os = new FileOutputStream(out)) {
                  byte[] buffer = new byte[64 * 1024];
                  int n;
                  long read = 0;
                  int lastPercent = -1;
                  while ((n = in.read(buffer)) > 0) {
                    if (downloadCancelled) break;
                    os.write(buffer, 0, n);
                    read += n;
                    if (total > 0) {
                      int percent = (int) Math.min(100, read * 100 / total);
                      if (percent != lastPercent) {
                        lastPercent = percent;
                        updateDownloadProgress(source.name, percent);
                      }
                    }
                  }
                }

                if (downloadCancelled) {
                  //noinspection ResultOfMethodCallIgnored
                  out.delete();
                  hideDownloadProgress();
                  return;
                }

                source.local = out;
                hideDownloadProgress();
                final File done = out;
                runOnUiThread(() -> callback.onFile(done));
              } catch (Exception error) {
                if (out != null) {
                  //noinspection ResultOfMethodCallIgnored
                  out.delete();
                }
                hideDownloadProgress();
                if (downloadCancelled) return;
                String message =
                    error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                toast("取文件失败：" + shorten(message));
              } finally {
                activeDownload = null;
                if (connection != null) connection.disconnect();
              }
            },
            "dsh-download")
        .start();
  }

  private void showDownloadProgress(String name) {
    hideDownloadProgress();
    runOnUiThread(
        () -> {
          LinearLayout box = new LinearLayout(this);
          box.setOrientation(LinearLayout.VERTICAL);
          box.setPadding(dp(20), dp(16), dp(20), dp(12));
          box.setBackground(rounded(dark ? 0xFF1A1E26 : 0xFFFFFFFF, 18));

          TextView title = new TextView(this);
          title.setText("正在取回文件");
          title.setTextSize(14.5f);
          title.setTypeface(null, android.graphics.Typeface.BOLD);
          title.setTextColor(dark ? 0xFFE9EEF7 : 0xFF16181D);
          box.addView(title);

          downloadLabel = new TextView(this);
          downloadLabel.setText(name);
          downloadLabel.setTextSize(12.5f);
          downloadLabel.setSingleLine(true);
          downloadLabel.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
          downloadLabel.setTextColor(dark ? 0xFF8B93A1 : 0xFF7A8088);
          LinearLayout.LayoutParams labelParams =
              new LinearLayout.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
          labelParams.topMargin = dp(4);
          box.addView(downloadLabel, labelParams);

          downloadBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
          downloadBar.setMax(100);
          downloadBar.setProgress(0);
          LinearLayout.LayoutParams barParams =
              new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4));
          barParams.topMargin = dp(12);
          box.addView(downloadBar, barParams);

          Button cancel = styledButton("取消", false);
          cancel.setOnClickListener(
              v -> {
                downloadCancelled = true;
                HttpURLConnection connection = activeDownload;
                if (connection != null) {
                  try {
                    connection.disconnect();
                  } catch (Exception ignored) {
                    // 已经断了
                  }
                }
                hideDownloadProgress();
              });
          LinearLayout.LayoutParams cancelParams =
              new LinearLayout.LayoutParams(
                  ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
          cancelParams.topMargin = dp(6);
          cancelParams.gravity = Gravity.END;
          box.addView(cancel, cancelParams);

          FrameLayout wrap = new FrameLayout(this);
          wrap.setPadding(dp(24), dp(24), dp(24), dp(24));
          wrap.addView(
              box,
              new FrameLayout.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

          Dialog dialog = new Dialog(this);
          dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
          dialog.setContentView(wrap);
          dialog.setCancelable(false);
          Window window = dialog.getWindow();
          if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            WindowManager.LayoutParams params = window.getAttributes();
            params.width = WindowManager.LayoutParams.MATCH_PARENT;
            params.height = WindowManager.LayoutParams.WRAP_CONTENT;
            window.setAttributes(params);
          }
          downloadDialog = dialog;
          dialog.show();
        });
  }

  private void updateDownloadProgress(String name, int percent) {
    runOnUiThread(
        () -> {
          if (downloadBar != null) downloadBar.setProgress(percent);
          if (downloadLabel != null) downloadLabel.setText(name + " · " + percent + "%");
        });
  }

  private void hideDownloadProgress() {
    runOnUiThread(
        () -> {
          Dialog dialog = downloadDialog;
          downloadDialog = null;
          downloadBar = null;
          downloadLabel = null;
          if (dialog != null) {
            try {
              dialog.dismiss();
            } catch (Exception ignored) {
              // 已经关了
            }
          }
        });
  }

  // ------------------------------------------------------------------ 安装 / 打开 / 分享

  private void installApk(Source source, File file) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        && !getPackageManager().canRequestPackageInstalls()) {
      pendingInstallSource = source;
      pendingInstallFile = file;
      showInstallPermissionDialog();
      return;
    }
    launchInstaller(source, file);
  }

  /** 交给系统安装器。APK 的 MIME 必须是 package-archive，否则会被当成普通文件。 */
  private void launchInstaller(Source source, File file) {
    Uri uri = PreviewProvider.uriFor(this, file);
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, APK_MIME);
    intent.setClipData(ClipData.newRawUri(file.getName(), uri));
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    try {
      startActivity(intent);
    } catch (Exception error) {
      toast("打不开系统安装器，改用浏览器");
      if (source != null) openInBrowser(source);
    }
  }

  private void showInstallPermissionDialog() {
    new AlertDialog.Builder(this)
        .setTitle("先允许安装应用")
        .setMessage(
            "安卓要求先允许「DSH Remote」安装未知来源的应用，才能把 APK 交给系统安装器。\n\n开启后回到这里，会继续安装。")
        .setPositiveButton(
            "去开启",
            (dialog, which) -> {
              try {
                startActivityForResult(
                    new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())),
                    INSTALL_PERMISSION_REQUEST);
              } catch (Exception error) {
                toast("请到系统设置里手动允许安装");
              }
            })
        .setNegativeButton(
            "取消",
            (dialog, which) -> {
              pendingInstallSource = null;
              pendingInstallFile = null;
            })
        .setCancelable(true)
        .show();
  }

  private void viewFile(Source source, File file) {
    Uri uri = PreviewProvider.uriFor(this, file);
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, source.mime);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(intent);
    } catch (Exception error) {
      openInBrowser(source);
    }
  }

  private void viewWithChooser(Source source, File file) {
    Uri uri = PreviewProvider.uriFor(this, file);
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, source.mime);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    Intent chooser = Intent.createChooser(intent, "用其他应用打开");
    chooser.putExtra(
        Intent.EXTRA_EXCLUDE_COMPONENTS,
        new ComponentName[] {new ComponentName(this, MainActivity.class)});
    try {
      startActivity(chooser);
    } catch (Exception error) {
      openInBrowser(source);
    }
  }

  private Intent buildShareIntent(Source source, File file) {
    Uri uri = PreviewProvider.uriFor(this, file);
    Intent send = new Intent(Intent.ACTION_SEND);
    send.setType(source.mime);
    send.putExtra(Intent.EXTRA_STREAM, uri);
    send.putExtra(Intent.EXTRA_TITLE, source.name);
    send.setClipData(ClipData.newUri(getContentResolver(), source.name, uri));
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    return send;
  }

  /** 系统分享：微信、QQ、钉钉等走 ACTION_SEND 的 App 都在这里（VIEW 列表里没有微信）。 */
  private void shareFile(Source source, File file, String packageName) {
    Intent send = buildShareIntent(source, file);
    if (packageName != null) {
      send.setPackage(packageName);
      try {
        startActivity(send);
        return;
      } catch (Exception error) {
        send.setPackage(null);
      }
    }
    try {
      startActivity(Intent.createChooser(send, "分享到"));
    } catch (Exception error) {
      toast("这台手机上找不到能接收文件的应用");
    }
  }

  private void shareToWechat(Source source, File file) {
    shareFile(source, file, WECHAT_PACKAGE);
  }

  private boolean wechatInstalled() {
    try {
      return getPackageManager().getLaunchIntentForPackage(WECHAT_PACKAGE) != null;
    } catch (Exception error) {
      return false;
    }
  }

  // ------------------------------------------------------------------ 浏览器

  /**
   * 「用浏览器打开」：服务器签一个 5 分钟的一次性链接（浏览器没有我们的 cookie）。
   *
   * <p>APK 这条链路上，relay 会给正确的 package-archive + attachment，浏览器下载完
   * 直接就能点安装；这也是一直以来「手机上装 APK」最顺的路。
   */
  private void openInBrowser(Source source) {
    if (source.path == null && source.url != null) {
      launchInBrowser(source.url);
      return;
    }
    if (source.path == null) {
      toast("拿不到文件地址");
      return;
    }
    new Thread(
            () -> {
              HttpURLConnection connection = null;
              try {
                String address =
                    "https://" + HOST + "/__fs/link?p=" + URLEncoder.encode(source.path, "UTF-8");
                connection = (HttpURLConnection) new URL(address).openConnection();
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                String cookie = CookieManager.getInstance().getCookie("https://" + HOST + "/");
                if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                if (connection.getResponseCode() != 200) {
                  toast("拿不到浏览器链接，稍后再试");
                  return;
                }
                String link = readAll(connection.getInputStream()).trim();
                if (!link.startsWith("https://")) {
                  toast("拿不到浏览器链接，稍后再试");
                  return;
                }
                runOnUiThread(() -> launchInBrowser(link));
              } catch (Exception error) {
                toast("拿不到浏览器链接：" + shorten(error.getMessage()));
              } finally {
                if (connection != null) connection.disconnect();
              }
            },
            "dsh-fs-link")
        .start();
  }

  /**
   * 打开默认浏览器。
   *
   * <p>不能直接对本站域名的链接做打开：我们自己声明了这个 host 的 VIEW，
   * 系统「打开方式」里会出现 DSH Remote，点错就原地打转。先用一个中性 URL 找到
   * 默认浏览器，再指定包名打开。
   */
  private void launchInBrowser(String link) {
    Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(link));
    view.addCategory(Intent.CATEGORY_BROWSABLE);
    view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

    Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"));
    probe.addCategory(Intent.CATEGORY_BROWSABLE);
    ResolveInfo browser =
        getPackageManager().resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY);
    if (browser != null
        && browser.activityInfo != null
        && !getPackageName().equals(browser.activityInfo.packageName)) {
      view.setPackage(browser.activityInfo.packageName);
      try {
        startActivity(view);
        return;
      } catch (Exception ignored) {
        view.setPackage(null);
      }
    }

    Intent chooser = Intent.createChooser(view, "用浏览器打开");
    chooser.putExtra(
        Intent.EXTRA_EXCLUDE_COMPONENTS,
        new ComponentName[] {new ComponentName(this, MainActivity.class)});
    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(chooser);
    } catch (Exception error) {
      toast("这台手机上没找到浏览器");
    }
  }

  // ------------------------------------------------------------------ 网页里的下载

  /** WebView 的下载回调：本站链接自己带 cookie 取，外部链接交给浏览器。 */
  private void onWebDownload(String url, String contentDisposition, String mimeType) {
    if (url == null || url.isEmpty()) return;
    if (!url.startsWith("https://" + HOST + "/")) {
      launchInBrowser(url);
      return;
    }
    String name = filenameFromDisposition(contentDisposition);
    if (name == null || name.isEmpty()) {
      String cleaned = url;
      int query = cleaned.indexOf('?');
      if (query >= 0) cleaned = cleaned.substring(0, query);
      name = cleaned.substring(cleaned.lastIndexOf('/') + 1);
    }
    if (name == null || name.isEmpty()) name = "download";
    String mime = mimeType == null || mimeType.isEmpty() ? FileTypes.mimeOf(name) : mimeType;
    showFileSheet(new Source(null, url, safeName(name), mime));
  }

  /** 从 Content-Disposition 里取文件名（Android 给的是服务器原样的头）。 */
  private static String filenameFromDisposition(String disposition) {
    if (disposition == null || disposition.isEmpty()) return null;
    try {
      int star = disposition.indexOf("filename*=UTF-8''");
      if (star >= 0) {
        String value = disposition.substring(star + "filename*=UTF-8''".length());
        int semi = value.indexOf(';');
        if (semi >= 0) value = value.substring(0, semi);
        return java.net.URLDecoder.decode(value.trim(), "UTF-8");
      }
      int plain = disposition.indexOf("filename=");
      if (plain >= 0) {
        String value = disposition.substring(plain + "filename=".length()).trim();
        if (value.startsWith("\"")) {
          int end = value.indexOf('"', 1);
          if (end > 0) value = value.substring(1, end);
        } else {
          int semi = value.indexOf(';');
          if (semi >= 0) value = value.substring(0, semi);
        }
        return value.trim();
      }
    } catch (Exception ignored) {
      // 解析失败就按 URL 猜
    }
    return null;
  }

  // ------------------------------------------------------------------ 主题 / 错误页

  private boolean isSystemDark() {
    int mode = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
    return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
  }

  /** 状态栏、导航栏、WebView 底色统一跟着页面主题走。 */
  private void applyBars(boolean darkMode) {
    dark = darkMode;
    int bg = darkMode ? DARK_BG : LIGHT_BG;
    Window window = getWindow();
    window.setStatusBarColor(bg);
    window.setNavigationBarColor(bg);
    int flags = window.getDecorView().getSystemUiVisibility();
    if (darkMode) {
      flags &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    } else {
      flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
    }
    window.getDecorView().setSystemUiVisibility(flags);
    if (web != null) web.setBackgroundColor(bg);
    if (errorLayer != null) {
      errorLayer.setBackgroundColor(bg);
      if (errorTitle != null) errorTitle.setTextColor(darkMode ? 0xFFE5E7EB : 0xFF16181D);
      if (errorDetail != null) errorDetail.setTextColor(darkMode ? 0xFF9AA4B2 : 0xFF61666B);
    }
  }

  /** 把 Chromium 的错误码翻成一句人话，别把 net::ERR_* 甩给用户。 */
  private static String friendlyError(WebResourceError error) {
    if (error == null) return "网络好像断了。";
    switch (error.getErrorCode()) {
      case WebViewClient.ERROR_HOST_LOOKUP:
        return "域名解析失败，手机可能没有网络。";
      case WebViewClient.ERROR_CONNECT:
        return "连不上服务器，检查手机网络后重试。";
      case WebViewClient.ERROR_TIMEOUT:
        return "连接超时，网络不太稳定。";
      case WebViewClient.ERROR_IO:
        return "网络连接被中断了。";
      default:
        return "网络好像断了。";
    }
  }

  /** 错误页按钮：主按钮蓝底白字，次按钮描边，不跟系统默认灰块走。 */
  private Button styledButton(String label, boolean primary) {
    Button button = new Button(this);
    button.setText(label);
    button.setAllCaps(false);
    button.setTextSize(14);
    button.setPadding(dp(22), dp(9), dp(22), dp(9));
    button.setMinWidth(0);
    button.setMinimumWidth(0);
    GradientDrawable bg = new GradientDrawable();
    bg.setCornerRadius(dp(12));
    if (primary) {
      bg.setColor(0xFF2563EB);
      button.setTextColor(Color.WHITE);
    } else {
      bg.setColor(Color.TRANSPARENT);
      bg.setStroke(dp(1), dark ? 0x33FFFFFF : 0x22000000);
      button.setTextColor(dark ? 0xFFE5E7EB : 0xFF16181D);
    }
    button.setBackground(bg);
    button.setStateListAnimator(null);
    return button;
  }

  /** 连不上电脑时的原生兜底页：给一句人话 + 两个能点的按钮，而不是白屏/英文错误页。 */
  private View buildErrorLayer() {
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER);
    box.setPadding(dp(28), dp(28), dp(28), dp(28));
    box.setBackgroundColor(dark ? DARK_BG : LIGHT_BG);
    box.setVisibility(View.GONE);

    errorTitle = new TextView(this);
    errorTitle.setText("连不上电脑");
    errorTitle.setTextSize(18);
    errorTitle.setGravity(Gravity.CENTER);
    errorTitle.setTextColor(dark ? 0xFFE5E7EB : 0xFF16181D);
    box.addView(errorTitle);

    errorDetail = new TextView(this);
    errorDetail.setTextSize(13);
    errorDetail.setGravity(Gravity.CENTER);
    errorDetail.setLineSpacing(dp(3), 1f);
    errorDetail.setTextColor(dark ? 0xFF9AA4B2 : 0xFF61666B);
    LinearLayout.LayoutParams detailParams =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    detailParams.topMargin = dp(10);
    box.addView(errorDetail, detailParams);

    Button retry = styledButton("重试", true);
    retry.setOnClickListener(
        v -> {
          hideError();
          if (web != null) web.reload();
        });
    LinearLayout.LayoutParams retryParams =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    retryParams.topMargin = dp(18);
    box.addView(retry, retryParams);

    Button pair = styledButton("重新配对", false);
    pair.setOnClickListener(
        v -> {
          hideError();
          if (web != null) web.loadUrl("https://" + HOST + "/__logout");
        });
    LinearLayout.LayoutParams pairParams =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    pairParams.topMargin = dp(4);
    box.addView(pair, pairParams);

    return box;
  }

  private void showError(String detail) {
    if (errorLayer == null) return;
    if (errorDetail != null) {
      errorDetail.setText(
          (detail == null || detail.isEmpty() ? "网络好像断了。" : detail)
              + "\n也可以确认电脑上的 dsh-remote 在运行，或重新配对。");
    }
    errorLayer.setVisibility(View.VISIBLE);
    errorLayer.bringToFront();
    updateBanner(false);
  }

  private void hideError() {
    if (errorLayer != null) errorLayer.setVisibility(View.GONE);
  }

  private int dp(int value) {
    return Math.round(getResources().getDisplayMetrics().density * value);
  }

  private String readAsset(String name) {
    try (InputStream in = getAssets().open(name)) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int n;
      while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
      return out.toString("UTF-8");
    } catch (Exception e) {
      return "";
    }
  }

  // ------------------------------------------------------------------ 任务完成提醒

  private void setupNotifications() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = getSystemService(NotificationManager.class);
      if (manager != null && manager.getNotificationChannel(CHANNEL_ID) == null) {
        NotificationChannel channel =
            new NotificationChannel(CHANNEL_ID, "任务完成", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("DSH 里的任务跑完时提醒");
        channel.enableVibration(true);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
      }
    }
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFY_PERMISSION_REQUEST);
    }
  }

  private boolean notificationAllowed() {
    return Build.VERSION.SDK_INT < 33
        || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
  }

  /** 任务结束：前台弹 Toast，后台发系统通知（点通知回到会话）。 */
  private void onTaskDone(String rawTitle) {
    String title = rawTitle == null ? "" : rawTitle.trim();
    if (title.length() > 48) title = title.substring(0, 47) + "…";

    if (foreground || !notificationAllowed()) {
      String message = title.isEmpty() ? "任务已完成" : "任务已完成 · " + title;
      Toast.makeText(this, message, Toast.LENGTH_LONG).show();
      return;
    }

    try {
      NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
      if (manager == null) return;
      Intent open = new Intent(this, MainActivity.class);
      open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
      int flags = PendingIntent.FLAG_UPDATE_CURRENT;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
      PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);

      Notification.Builder builder =
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
              ? new Notification.Builder(this, CHANNEL_ID)
              : new Notification.Builder(this);
      int smallIcon = getResources().getIdentifier("ic_stat_dsh", "drawable", getPackageName());
      if (smallIcon == 0) smallIcon = getApplicationInfo().icon;
      builder
          .setSmallIcon(smallIcon)
          .setContentTitle("任务已完成")
          .setContentText(title.isEmpty() ? "DSH 里的任务跑完了" : "「" + title + "」跑完了")
          .setTicker("任务已完成")
          .setAutoCancel(true)
          .setShowWhen(true)
          .setWhen(System.currentTimeMillis())
          .setCategory(Notification.CATEGORY_MESSAGE)
          .setPriority(Notification.PRIORITY_HIGH)
          .setContentIntent(pending);
      manager.notify(NOTIFY_ID, builder.build());
    } catch (Exception ignored) {
      // 通知失败不影响主流程
    }
  }

  /**
   * 任务结束监听：DSH 生成时输入框主按钮 aria-busy=true，结束变回 false。
   * 切会话（标题变化）不算完成，避免误报。
   */
  private void injectDoneWatch() {
    if (web == null) return;
    String js =
        "(function(){"
            + "if(window.__dshxDone)return;window.__dshxDone=true;"
            + "function running(){try{return !!document.querySelector('[class*=\"primary\"][aria-busy=\"true\"]');}catch(e){return false}}"
            + "function title(){try{var h=document.querySelector('header');var t=h?h.innerText.split('\\n')[0].trim():'';"
            + "  return (t||document.title||'').slice(0,60);}catch(e){return ''}}"
            + "var last=running(),lastTitle=title(),lastRun=0;"
            + "function check(){var now=running(),t=title();"
            + "  if(!last&&now){last=true;lastTitle=t;return;}"
            + "  if(last&&now){lastTitle=t;return;}"
            + "  if(last&&!now){last=false;"
            + "    if(t!==lastTitle){lastTitle=t;return;}"
            + "    try{DSHRemote.taskDone(t);}catch(e){}"
            + "  }"
            + "}"
            // 页面切后台时 requestAnimationFrame 会停，这里直接用 MutationObserver 回调 + 80ms 节流
            + "function schedule(){var now=Date.now();if(now-lastRun<80)return;lastRun=now;check();}"
            + "try{new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,"
            + "  attributes:true,attributeFilter:['aria-busy','aria-label']});}catch(e){}"
            + "})();";
    web.evaluateJavascript(js, null);
  }

  // ------------------------------------------------------------------ 冷启动 / 掉线提示

  /** 冷启动过渡页：图标 + 一句「正在连接电脑…」，首帧出来就淡出。 */
  private View buildSplash() {
    FrameLayout layer = new FrameLayout(this);
    layer.setBackgroundColor(dark ? DARK_BG : LIGHT_BG);

    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER_HORIZONTAL);

    ImageView icon = new ImageView(this);
    try {
      icon.setImageResource(getApplicationInfo().icon);
    } catch (Exception ignored) {
      // 图标资源异常就不显示，不影响启动
    }
    box.addView(icon, new LinearLayout.LayoutParams(dp(64), dp(64)));

    TextView title = new TextView(this);
    title.setText("DSH Remote");
    title.setTextSize(17);
    title.setTypeface(null, android.graphics.Typeface.BOLD);
    title.setTextColor(dark ? 0xFFE5E7EB : 0xFF16181D);
    LinearLayout.LayoutParams titleParams =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    titleParams.topMargin = dp(16);
    box.addView(title, titleParams);

    TextView sub = new TextView(this);
    sub.setText("正在连接电脑…");
    sub.setTextSize(12.5f);
    sub.setTextColor(dark ? 0xFF9AA4B2 : 0xFF61666B);
    LinearLayout.LayoutParams subParams =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    subParams.topMargin = dp(6);
    box.addView(sub, subParams);

    ProgressBar bar = new ProgressBar(this);
    bar.setIndeterminate(true);
    LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(dp(22), dp(22));
    barParams.topMargin = dp(18);
    box.addView(bar, barParams);

    layer.addView(
        box,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
    return layer;
  }

  private void hideSplash() {
    if (splashView == null || splashDone) return;
    splashDone = true;
    long wait = Math.max(0L, 450L - (SystemClock.uptimeMillis() - splashAt));
    splashView.postDelayed(
        () -> {
          if (splashView == null) return;
          splashView
              .animate()
              .alpha(0f)
              .setDuration(200)
              .withEndAction(
                  () -> {
                    if (splashView != null) splashView.setVisibility(View.GONE);
                  })
              .start();
        },
        wait);
  }

  /** 细横幅：页面还开着但电脑掉线时，至少让人知道现在按了没反应。 */
  private TextView buildOfflineBanner() {
    TextView view = new TextView(this);
    view.setText("电脑没连上 · 点此重试");
    view.setTextSize(12.5f);
    view.setTextColor(Color.WHITE);
    view.setGravity(Gravity.CENTER);
    view.setBackgroundColor(0xFFB45309);
    view.setVisibility(View.GONE);
    view.setOnClickListener(
        v -> {
          offlineBanner.setVisibility(View.GONE);
          healthDown = false;
          if (web != null) web.reload();
        });
    return view;
  }

  private void updateBanner(boolean down) {
    if (offlineBanner == null) return;
    boolean pageReady =
        (errorLayer == null || errorLayer.getVisibility() != View.VISIBLE)
            && (splashView == null || splashView.getVisibility() != View.VISIBLE);

    if (down) {
      healthDown = true;
      offlineBanner.setText("电脑没连上 · 点此重试");
      offlineBanner.setBackgroundColor(0xFFB45309);
      offlineBanner.setVisibility(pageReady ? View.VISIBLE : View.GONE);
      return;
    }

    boolean recovered = healthDown;
    healthDown = false;
    if (recovered && pageReady) {
      // 断线期间页面里的模型列表/WebSocket 可能已经废了，给一个显眼的刷新入口，6 秒后自动收起。
      offlineBanner.setText("网络已恢复 · 点此刷新");
      offlineBanner.setBackgroundColor(0xFF2563EB);
      offlineBanner.setVisibility(View.VISIBLE);
      ui.postDelayed(
          () -> {
            if (!healthDown && offlineBanner != null) offlineBanner.setVisibility(View.GONE);
          },
          6000);
    } else {
      offlineBanner.setVisibility(View.GONE);
    }
  }

  private final Runnable healthTick =
      new Runnable() {
        @Override
        public void run() {
          checkHealth();
          ui.postDelayed(this, HEALTH_INTERVAL_MS);
        }
      };

  private void startHealthWatch() {
    if (healthIo == null || healthIo.isShutdown()) healthIo = Executors.newSingleThreadExecutor();
    ui.removeCallbacks(healthTick);
    ui.post(healthTick);
  }

  private void stopHealthWatch() {
    ui.removeCallbacks(healthTick);
  }

  /** 用公开的 /__health 判断「relay 在线但 agent 掉了」，比 WebView 自己静默卡住更早发现。 */
  private void checkHealth() {
    final ExecutorService pool = healthIo;
    if (pool == null || pool.isShutdown()) return;
    pool.execute(
        () -> {
          boolean down = true;
          HttpURLConnection connection = null;
          try {
            URL url = new URL("https://" + HOST + "/__health");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            if (connection.getResponseCode() == 200) {
              org.json.JSONObject json = new org.json.JSONObject(readAll(connection.getInputStream()));
              down = !json.optBoolean("agent", false) || json.optBoolean("upstreamDown", false);
            }
          } catch (Exception ignored) {
            down = true;
          } finally {
            if (connection != null) connection.disconnect();
          }
          final boolean isDown = down;
          runOnUiThread(() -> updateBanner(isDown));
        });
  }

  // ------------------------------------------------------------------ 小工具

  private static String readAll(InputStream in) {
    if (in == null) return "";
    try (InputStream stream = in) {
      byte[] buffer = new byte[8192];
      StringBuilder sb = new StringBuilder();
      int n;
      while ((n = stream.read(buffer)) > 0) sb.append(new String(buffer, 0, n, "UTF-8"));
      return sb.toString();
    } catch (Exception e) {
      return "";
    }
  }

  private static String shorten(String text) {
    if (text == null) return "";
    return text.length() <= 60 ? text : text.substring(0, 57) + "…";
  }

  private static String safeName(String path) {
    String name = path.substring(path.lastIndexOf('/') + 1);
    name = name.replaceAll("[^A-Za-z0-9._\\-\\u4e00-\\u9fa5]", "_");
    if (name.isEmpty() || name.startsWith(".")) name = "preview_" + name;
    return name;
  }

  private void toast(String message) {
    runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
  }

  // ------------------------------------------------------------------ 生命周期

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == FILE_CHOOSER_REQUEST) {
      if (filePathCallback != null) {
        filePathCallback.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        filePathCallback = null;
      }
      return;
    }
    if (requestCode == INSTALL_PERMISSION_REQUEST) {
      Source source = pendingInstallSource;
      File file = pendingInstallFile;
      pendingInstallSource = null;
      pendingInstallFile = null;
      if (file == null) return;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
          && getPackageManager().canRequestPackageInstalls()) {
        launchInstaller(source, file);
      } else {
        toast("还没允许安装，打开开关后再点一次安装");
      }
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  @Override
  public void onBackPressed() {
    if (web != null) {
      web.evaluateJavascript(
          "(function(){try{"
              + "var b=document.querySelector('[data-mobile-nav=\"backdrop\"],[aria-label=\"Close\"],[aria-label=\"关闭\"],.backdrop,[data-dismiss]');"
              + "if(b){b.click();return 'closed'}"
              + "return 'none'}catch(e){return 'err'}})()",
          value -> {
            boolean handled = value != null && value.contains("closed");
            if (handled) return;
            if (web.canGoBack()) {
              web.goBack();
              return;
            }
            long now = System.currentTimeMillis();
            if (now - lastBackAt < 2000) {
              finish();
            } else {
              lastBackAt = now;
              toast("再按一次退出");
            }
          });
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onResume() {
    super.onResume();
    foreground = true;
    startHealthWatch();
  }

  @Override
  protected void onPause() {
    foreground = false;
    stopHealthWatch();
    super.onPause();
  }

  @Override
  protected void onSaveInstanceState(Bundle outState) {
    super.onSaveInstanceState(outState);
    if (web != null) web.saveState(outState);
  }

  @Override
  protected void onDestroy() {
    stopHealthWatch();
    if (healthIo != null) healthIo.shutdownNow();
    if (web != null) {
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }
}
