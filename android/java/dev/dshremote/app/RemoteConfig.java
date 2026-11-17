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
 * <p>两条通路，规则不同：
 * <ul>
 *   <li><b>公网</b>：必须 https。手机和服务器之间隔着互联网，明文等于把会话 cookie
 *       送给路上的每一跳。</li>
 *   <li><b>局域网</b>：允许 http，但<b>只对私有地址</b>放行（RFC1918 / 回环 / 链路本地 /
 *       {@code *.local}）。局域网里没有可信证书可用，强行要求 https 等于让这个模式
 *       根本没法用。</li>
 * </ul>
 * 判定集中在 {@link #isPrivateHost}，不在别处复制。
 */
public final class RemoteConfig {

  private static final String PREFS = "dsh_remote";
  private static final String KEY_SCHEME = "scheme";
  private static final String KEY_AUTHORITY = "authority";
  private static final String KEY_PAIR_CODE = "pair_code";

  private final SharedPreferences prefs;

  public RemoteConfig(Context context) {
    this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** {@code https} 或 {@code http}；没配置时返回 {@code https}。 */
  public String scheme() {
    String value = prefs.getString(KEY_SCHEME, "https");
    return value == null || value.isEmpty() ? "https" : value;
  }

  /** 已配置的 {@code host[:port]}；没配返回空串。 */
  public String authority() {
    String value = prefs.getString(KEY_AUTHORITY, "");
    return value == null ? "" : value.trim();
  }

  public boolean isConfigured() {
    return !authority().isEmpty();
  }

  /** 站点根地址，形如 {@code https://dsh.example.com} 或 {@code http://192.168.1.5:3081}。 */
  public String origin() {
    String value = authority();
    return value.isEmpty() ? "" : scheme() + "://" + value;
  }

  /** 只有主机名、没有端口——{@code Uri.getHost()} 比对的也是这个。 */
  public String hostName() {
    return hostNameOf(authority());
  }

  /** 是不是本站域名（含子域）。 */
  public boolean matchesHost(String host) {
    return hostMatches(authority(), host);
  }

  public void save(Endpoint endpoint, String pairCode) {
    if (endpoint == null) return;
    prefs
        .edit()
        .putString(KEY_SCHEME, endpoint.scheme)
        .putString(KEY_AUTHORITY, endpoint.authority)
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

  // ---------------------------------------------------------------- 解析

  /** 解析结果：{@code scheme} + {@code host[:port]}。 */
  public static final class Endpoint {
    public final String scheme;
    public final String authority;

    Endpoint(String scheme, String authority) {
      this.scheme = scheme;
      this.authority = authority;
    }

    public String origin() {
      return scheme + "://" + authority;
    }

    /** 授权显示用的短描述，例如 {@code 192.168.1.5:3081（局域网）}。 */
    public String label() {
      return "http".equals(scheme) ? authority + "（局域网）" : authority;
    }

    @Override
    public String toString() {
      return origin();
    }
  }

  /**
   * 把用户输入（或二维码里解出来的地址）规范成 {@link Endpoint}。
   *
   * <p>容忍：{@code dsh.example.com}、{@code https://dsh.example.com/}、
   * {@code https://dsh.example.com/__pair?code=ABC12345}、
   * {@code dsh.example.com:8443}、{@code http://192.168.1.5:3081}。
   *
   * <p>不给协议时按主机判断：私有地址默认 http（局域网），其余默认 https。
   *
   * @return 规范化结果；不合法返回 {@code null}
   */
  public static Endpoint parseEndpoint(String input) {
    if (input == null) return null;
    String text = input.trim();
    if (text.isEmpty()) return null;

    String lower = text.toLowerCase(Locale.ROOT);
    String scheme = null;
    if (lower.startsWith("https://")) {
      scheme = "https";
      text = text.substring(8);
    } else if (lower.startsWith("http://")) {
      scheme = "http";
      text = text.substring(7);
    } else if (lower.contains("://")) {
      return null; // 别的协议不是我们的
    }

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
    if (!text.matches("[A-Za-z0-9.:_-]+")) return null;

    int colon = text.indexOf(':');
    String host = colon < 0 ? text : text.substring(0, colon);
    if (host.isEmpty() || host.startsWith(".") || host.endsWith(".") || host.contains("..")) {
      return null;
    }
    if (!host.contains(".") && !"localhost".equalsIgnoreCase(host)) return null;
    // 看着像 IPv4 就必须是合法 IPv4，否则 192.168.1.999 这种会被当域名放行
    if (host.matches("[0-9.]+")) {
      String[] octets = host.split("\\.", -1);
      if (octets.length != 4) return null;
      for (String octet : octets) {
        if (octet.isEmpty() || octet.length() > 3) return null;
        if (Integer.parseInt(octet) > 255) return null;
      }
    }

    if (colon >= 0) {
      int port;
      try {
        port = Integer.parseInt(text.substring(colon + 1));
      } catch (NumberFormatException e) {
        return null;
      }
      if (port < 1 || port > 65535) return null;
    }

    String authority = text.toLowerCase(Locale.ROOT);
    boolean local = isPrivateHost(host);
    if (scheme == null) {
      // 没写协议：局域网地址默认 http，公网地址默认 https
      scheme = local ? "http" : "https";
    }
    if ("http".equals(scheme) && !local) return null; // 公网不走明文

    return new Endpoint(scheme, authority);
  }

  /**
   * 私有 / 本地可达地址：RFC1918、回环、链路本地，以及 {@code *.local}。
   *
   * <p>只有这些地址允许走明文 http。
   */
  public static boolean isPrivateHost(String host) {
    if (host == null) return false;
    String value = host.trim().toLowerCase(Locale.ROOT);
    if (value.isEmpty()) return false;
    if ("localhost".equals(value)) return true;
    if (value.endsWith(".local")) return true;

    String[] parts = value.split("\\.");
    if (parts.length != 4) return false;
    int[] octets = new int[4];
    for (int i = 0; i < 4; i += 1) {
      if (parts[i].isEmpty() || parts[i].length() > 3) return false;
      for (int j = 0; j < parts[i].length(); j += 1) {
        if (!Character.isDigit(parts[i].charAt(j))) return false;
      }
      octets[i] = Integer.parseInt(parts[i]);
      if (octets[i] > 255) return false;
    }
    if (octets[0] == 127) return true; // 回环
    if (octets[0] == 10) return true; // 10/8
    if (octets[0] == 192 && octets[1] == 168) return true; // 192.168/16
    if (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) return true; // 172.16/12
    if (octets[0] == 169 && octets[1] == 254) return true; // 链路本地
    return false;
  }

  // ---------------------------------------------------------------- 供纯 JVM 单测用的静态辅助

  /**
   * {@link #hostName()} 的静态版，方便单测（不需要 {@code Context}）。
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
}
