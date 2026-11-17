package dev.dshremote.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 扫码页：把手机相机画面交给 WebView 里的一个本地页面，用 jsQR 在页面内解码。
 *
 * <p>为什么不写原生解码：这个壳刻意零 Gradle、零 AndroidX、零 jar 依赖，
 * 引一个 ZXing 会多打进 500KB 的 dex。改成「WebView + 一个纯 JS 解码器（130KB assets）」
 * 后，原生侧只剩相机权限和一条 JS 桥。
 *
 * <p>为什么不用 file:// 加载页面：{@code getUserMedia} 只在安全上下文可用，
 * file:// 不算。这里用一个不可能被解析到公网的主机名，配合
 * {@link WebViewClient#shouldInterceptRequest} 在进程内把 assets 直接喂回去——
 * <b>不会真的发网络请求</b>，但页面拿到的是 https 安全上下文，相机才能开。
 */
public class ScanActivity extends Activity {

  /** 结果回传：二维码里的原始文本。 */
  public static final String EXTRA_RESULT = "scan_result";

  /** 只存在于拦截器里的虚拟主机，公网解析不到。 */
  private static final String SCAN_HOST = "scan.dshremote.invalid";
  private static final String PAGE_URL = "https://" + SCAN_HOST + "/scan.html";
  private static final int REQUEST_CAMERA = 2001;

  private WebView web;
  private PermissionRequest pendingRequest;
  private boolean resultSent = false;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(0xFF0F1115);

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    web.setBackgroundColor(0xFF0F1115);
    web.addJavascriptInterface(new Bridge(), "DSHRemoteScan");

    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public WebResourceResponse shouldInterceptRequest(
              WebView view, WebResourceRequest request) {
            return serveLocal(request == null ? null : request.getUrl());
          }
        });

    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public void onPermissionRequest(final PermissionRequest request) {
            // 只批相机；麦克风之类的直接拒掉
            final Uri origin = request.getOrigin();
            runOnUiThread(
                () -> {
                  if (origin == null || !SCAN_HOST.equals(origin.getHost())) {
                    request.deny();
                    return;
                  }
                  if (!wantsVideo(request)) {
                    request.deny();
                    return;
                  }
                  if (hasCameraPermission()) {
                    request.grant(request.getResources());
                  } else {
                    pendingRequest = request;
                    requestPermissions(new String[] {Manifest.permission.CAMERA}, REQUEST_CAMERA);
                  }
                });
          }
        });

    root.addView(
        web,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(root);

    web.loadUrl(PAGE_URL);
  }

  private static boolean wantsVideo(PermissionRequest request) {
    for (String resource : request.getResources()) {
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return true;
    }
    return false;
  }

  private boolean hasCameraPermission() {
    return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(requestCode, permissions, results);
    if (requestCode != REQUEST_CAMERA) return;
    PermissionRequest request = pendingRequest;
    pendingRequest = null;
    if (request == null) return;
    if (hasCameraPermission()) request.grant(request.getResources());
    else request.deny();
  }

  /**
   * 把虚拟主机下的两个文件从 assets 里读出来。
   *
   * @param url 请求地址；不是虚拟主机的返回 {@code null}（交给 WebView 走正常网络）
   */
  private WebResourceResponse serveLocal(Uri url) {
    if (url == null || !SCAN_HOST.equals(url.getHost())) return null;
    String path = url.getPath() == null ? "/" : url.getPath();
    String asset =
        "/vendor/jsQR.min.js".equals(path)
            ? "vendor/jsQR.min.js"
            : "scan.html"; // 其余一律给页面本身，省得出现 404 白屏
    String mime = asset.endsWith(".js") ? "application/javascript" : "text/html";
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    try {
      InputStream in = getAssets().open(asset);
      return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, in);
    } catch (IOException e) {
      byte[] body = ("找不到资源：" + asset).getBytes(StandardCharsets.UTF_8);
      return new WebResourceResponse(
          "text/plain", "utf-8", 500, "Error", headers, new ByteArrayInputStream(body));
    }
  }

  private void finishWithResult(String text) {
    if (resultSent) return;
    resultSent = true;
    stopCamera();
    setResult(RESULT_OK, new Intent().putExtra(EXTRA_RESULT, text));
    finish();
  }

  private void finishCancelled() {
    if (resultSent) return;
    resultSent = true;
    stopCamera();
    setResult(RESULT_CANCELED);
    finish();
  }

  /** 让页面把相机放掉再退出，否则有些机型会卡住摄像头。 */
  private void stopCamera() {
    if (web == null) return;
    web.evaluateJavascript(
        "try{window.dispatchEvent(new Event('pagehide'))}catch(e){}", null);
  }

  @Override
  public void onBackPressed() {
    finishCancelled();
  }

  @Override
  protected void onDestroy() {
    if (pendingRequest != null) {
      pendingRequest.deny();
      pendingRequest = null;
    }
    if (web != null) {
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }

  /** 页面解码成功后回调这里。 */
  private final class Bridge {
    @JavascriptInterface
    public void done(String text) {
      final String value = text == null ? "" : text.trim();
      runOnUiThread(
          () -> {
            if (value.isEmpty()) finishCancelled();
            else finishWithResult(value);
          });
    }

    @JavascriptInterface
    public void cancel() {
      runOnUiThread(ScanActivity.this::finishCancelled);
    }
  }
}
