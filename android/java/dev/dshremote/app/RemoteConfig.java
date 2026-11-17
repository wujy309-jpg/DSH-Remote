package dev.dshremote.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;

/**
 * 运行时服务器配置。
 *
 * <p>一个安装包要能连任意一台自建服务器，所以地址不能编译期写死：存在
 * {@link SharedPreferences} 里，首次启动由设置页填（构建期注入的
 * {@link BuildConfig#HOST} 只作为预填的默认值）。
 *
 * <p>只存 {@code host[:port]}，协议固定 https——手机端必须过 TLS，
 * 这里不做「允许 http」的开关，少一个被误用的口子。
 */
public final class RemoteConfig {

  private static final String PREFS = "dsh_remote";
  private static final String KEY_AUTHORITY = "authority";
  private static final String KEY_PAIR_CODE = "pair_code";

  private final SharedPreferences prefs;

  public RemoteConfig(Context context) {
    this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** 已配置的 {@code host[:port]}；没配返回空串。 */
  public String authority() {
    String value = prefs.getString(KEY_AUTHORITY, "");
    return value == null ? "" : value.trim();
  }

  public boolean isConfigured() {
    return !authority().isEmpty();
  }

  /** 站点根地址，形如 {@code https://dsh.example.com:8443}（不带结尾斜杠）。 */
  public String origin() {
    String value = authority();
    return value.isEmpty() ? "" : "https://" + value;
  }

  /** 只有主机名、没有端口——{@code Uri.getHost()} 比对的也是这个。 */
  public String hostName() {
    return hostNameOf(authority());
  }

  /** 是不是本站域名（含子域）。 */
  public boolean matchesHost(String host) {
    return hostMatches(authority(), host);
  }

  /**
   * {@link #hostName()} 的静态版，方便纯 JVM 单测（不需要 {@code Context}）。
   *
   * @param authority {@code host[:port]}，可为 null / 空
   */
  public static String hostNameOf(String authority) {
    String value = authority == null ? "" : authority.trim();
    int colon = value.indexOf(':');
    return colon < 0 ? value : value.substring(0, colon);
  }

  /**
   * 判断某个 Host 是不是这台服务器（含子域）。
   *
   * @param authority 已配置的 {@code host[:port]}
   * @param host      待比对的 Host（不含端口，和 {@code Uri.getHost()} 一致）
   */
  public static boolean hostMatches(String authority, String host) {
    String mine = hostNameOf(authority).toLowerCase(Locale.ROOT);
    if (mine.isEmpty() || host == null) return false;
    String other = host.trim().toLowerCase(Locale.ROOT);
    return other.equals(mine) || other.endsWith("." + mine);
  }

  public void save(String authority, String pairCode) {
    prefs
        .edit()
        .putString(KEY_AUTHORITY, authority == null ? "" : authority)
        .putString(KEY_PAIR_CODE, pairCode == null ? "" : pairCode.trim())
        .apply();
  }

  public void clear() {
    prefs.edit().clear().apply();
  }

  /** 取走一次性配对码，读过就清掉——不然每次冷启动都会重新走一遍配对。 */
  public String takePairCode() {
    String code = prefs.getString(KEY_PAIR_CODE, "");
    if (code == null || code.isEmpty()) return "";
    prefs.edit().putString(KEY_PAIR_CODE, "").apply();
    return code;
  }

  /**
   * 把用户输入（或二维码里解出来的地址）规范成 {@code host[:port]}。
   *
   * <p>容忍以下几种写法：{@code dsh.example.com}、{@code https://dsh.example.com/}、
   * {@code https://dsh.example.com/__pair?code=ABC12345}、
   * {@code dsh.example.com:8443}。路径、查询串、片段都会被丢掉。
   *
   * @return 规范后的 authority（小写）；不合法返回 {@code null}
   */
  public static String normalizeAuthority(String input) {
    if (input == null) return null;
    String text = input.trim();
    if (text.isEmpty()) return null;

    String lower = text.toLowerCase(Locale.ROOT);
    if (lower.startsWith("http://")) return null; // 明文不接
    if (lower.startsWith("https://")) text = text.substring(8);
    else if (lower.contains("://")) return null; // 别的协议不是我们的

    // 丢掉路径 / 查询串 / 片段
    for (int i = 0; i < text.length(); i += 1) {
      char c = text.charAt(i);
      if (c == '/' || c == '?' || c == '#') {
        text = text.substring(0, i);
        break;
      }
    }
    text = text.trim();
    if (text.isEmpty()) return null;
    if (!text.matches("[A-Za-z0-9.-]+(:[0-9]{1,5})?")) return null;

    int colon = text.indexOf(':');
    String host = colon < 0 ? text : text.substring(0, colon);
    if (host.isEmpty()) return null;
    if (host.startsWith(".") || host.endsWith(".") || host.contains("..")) return null;
    // 要么是带点的域名，要么是 localhost——其余基本都是输错了
    if (!host.contains(".") && !"localhost".equalsIgnoreCase(host)) return null;

    if (colon >= 0) {
      int port;
      try {
        port = Integer.parseInt(text.substring(colon + 1));
      } catch (NumberFormatException e) {
        return null;
      }
      if (port < 1 || port > 65535) return null;
    }
    return text.toLowerCase(Locale.ROOT);
  }
}
