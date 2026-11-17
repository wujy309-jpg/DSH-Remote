package dev.dshremote.app;

/**
 * {@link RemoteConfig#parseEndpoint} / {@link RemoteConfig#hostMatches} 的纯 JVM 自检。
 *
 * <p>这是「运行时配置」里最容易写错的一环：要同时吃下公网域名、局域网 IP、配对链接，
 * 还要按主机类型决定能不能走明文 http。这些都不需要模拟器。
 *
 * <pre>
 *   cd android &amp;&amp; ./test-logic.sh
 * </pre>
 */
public final class RemoteConfigTest {

  private static int failed = 0;

  public static void main(String[] args) {
    System.out.println("RemoteConfig.parseEndpoint —— 公网");

    ok("dsh.example.com", "https", "dsh.example.com");
    ok("  dsh.example.com  ", "https", "dsh.example.com");
    ok("Dsh.Example.COM", "https", "dsh.example.com");
    ok("https://dsh.example.com", "https", "dsh.example.com");
    ok("https://dsh.example.com/", "https", "dsh.example.com");
    ok("https://dsh.example.com/app/session?id=1", "https", "dsh.example.com");
    ok("https://dsh.example.com/__pair?code=ABCD2345&next=%2F", "https", "dsh.example.com");
    ok("dsh.example.com/__pair?code=ABCD2345", "https", "dsh.example.com");
    ok("dsh.example.com:8443", "https", "dsh.example.com:8443");
    ok("https://dsh.example.com:8443/", "https", "dsh.example.com:8443");
    ok("8.8.8.8", "https", "8.8.8.8");
    ok("172.32.1.1", "https", "172.32.1.1");

    System.out.println("\nRemoteConfig.parseEndpoint —— 局域网（允许 http）");
    ok("192.168.1.5:3081", "http", "192.168.1.5:3081");
    ok("http://192.168.1.5:3081", "http", "192.168.1.5:3081");
    ok("http://192.168.1.5", "http", "192.168.1.5");
    ok("192.168.1.5:3081/__pair?code=ABCD2345", "http", "192.168.1.5:3081");
    ok("http://192.168.1.5:3081/__pair?code=ABCD2345", "http", "192.168.1.5:3081");
    ok("10.0.0.7:3081", "http", "10.0.0.7:3081");
    ok("172.16.3.9:3081", "http", "172.16.3.9:3081");
    ok("172.31.255.254:3081", "http", "172.31.255.254:3081");
    ok("127.0.0.1:3081", "http", "127.0.0.1:3081");
    ok("localhost:3081", "http", "localhost:3081");
    ok("macbook.local:3081", "http", "macbook.local:3081");
    ok("169.254.10.2:3081", "http", "169.254.10.2:3081");
    // 局域网地址也可以显式要求 https（自签证书那种玩法），不拦
    ok("https://192.168.1.5:3081", "https", "192.168.1.5:3081");

    System.out.println("\nRemoteConfig.parseEndpoint —— 必须挡掉");
    bad("http://dsh.example.com", "公网不许明文");
    bad("http://8.8.8.8", "公网 IP 不许明文");
    bad("http://172.32.1.1", "172.32 不在 172.16/12 里，按公网处理，不许明文");
    bad("ftp://dsh.example.com", "别的协议");
    bad("", "空串");
    bad("   ", "全空白");
    bad("https://", "没有主机");
    bad("http://", "没有主机");
    bad("/", "只有路径");
    bad("dshexamplecom", "没有点的裸词");
    bad(".dsh.example.com", "以点开头");
    bad("dsh.example.com.", "以点结尾");
    bad("dsh..example.com", "连续点");
    bad("dsh.example.com:0", "端口 0");
    bad("dsh.example.com:70000", "端口越界");
    bad("dsh.example.com:abc", "端口不是数字");
    bad("dsh example.com", "含空格");
    bad("https://dsh.example.com:8443:1", "两个端口");
    bad("192.168.1.999", "第 4 段越界");
    bad(null, "null");

    System.out.println("\nRemoteConfig.isPrivateHost");
    privateOk("192.168.0.1");
    privateOk("10.1.2.3");
    privateOk("172.16.0.1");
    privateOk("172.31.0.1");
    privateOk("127.0.0.1");
    privateOk("169.254.1.1");
    privateOk("localhost");
    privateOk("MacBook.local");
    privateNo("172.15.0.1", "172.15 属于公网段");
    privateNo("172.32.0.1", "172.32 属于公网段");
    privateNo("11.0.0.1", "11/8 不是私网");
    privateNo("8.8.8.8");
    privateNo("dsh.example.com");

    System.out.println("\nRemoteConfig.hostMatches");
    matchOk("dsh.example.com", "dsh.example.com");
    matchOk("Dsh.Example.com", "dsh.example.com");
    matchOk("a.dsh.example.com", "dsh.example.com");
    matchOk("192.168.1.5", "192.168.1.5:3081");
    matchNo("other.example.com", "dsh.example.com");
    matchNo("evildsh.example.com", "dsh.example.com");
    matchNo("example.com", "dsh.example.com");
    matchNo("192.168.1.6", "192.168.1.5:3081");

    System.out.println();
    if (failed == 0) {
      System.out.println("ALL OK");
    } else {
      System.out.println(failed + " FAILED");
      System.exit(1);
    }
  }

  private static void ok(String input, String scheme, String authority) {
    RemoteConfig.Endpoint actual = RemoteConfig.parseEndpoint(input);
    if (actual == null) {
      failed += 1;
      System.out.println("FAIL " + show(input) + " -> null，期望 " + scheme + "://" + authority);
      return;
    }
    if (scheme.equals(actual.scheme) && authority.equals(actual.authority)) {
      System.out.println("ok   " + show(input) + " -> " + actual);
    } else {
      failed += 1;
      System.out.println(
          "FAIL " + show(input) + " -> " + actual + "，期望 " + scheme + "://" + authority);
    }
  }

  private static void bad(String input, String why) {
    RemoteConfig.Endpoint actual = RemoteConfig.parseEndpoint(input);
    if (actual == null) {
      System.out.println("ok   " + show(input) + " 被拒（" + why + "）");
    } else {
      failed += 1;
      System.out.println("FAIL " + show(input) + " 应该被拒，却得到 " + actual);
    }
  }

  private static void privateOk(String host) {
    if (RemoteConfig.isPrivateHost(host)) {
      System.out.println("ok   " + host + " 是私有/本地地址");
    } else {
      failed += 1;
      System.out.println("FAIL " + host + " 应该是私有/本地地址");
    }
  }

  private static void privateNo(String host) {
    privateNo(host, "公网地址");
  }

  private static void privateNo(String host, String why) {
    if (!RemoteConfig.isPrivateHost(host)) {
      System.out.println("ok   " + host + " 不是私有地址（" + why + "）");
    } else {
      failed += 1;
      System.out.println("FAIL " + host + " 不该被当成私有地址");
    }
  }

  private static void matchOk(String host, String configured) {
    if (RemoteConfig.hostMatches(configured, host)) {
      System.out.println("ok   " + configured + " 认为自己包含 " + host);
    } else {
      failed += 1;
      System.out.println("FAIL " + configured + " 应该包含 " + host);
    }
  }

  private static void matchNo(String host, String configured) {
    if (!RemoteConfig.hostMatches(configured, host)) {
      System.out.println("ok   " + configured + " 不包含 " + host);
    } else {
      failed += 1;
      System.out.println("FAIL " + configured + " 不该包含 " + host);
    }
  }

  private static String show(String input) {
    return input == null ? "null" : "\"" + input + "\"";
  }
}
