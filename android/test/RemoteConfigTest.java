package dev.dshremote.app;

/**
 * {@link RemoteConfig#normalizeAuthority} 的纯 JVM 自检。
 *
 * <p>这是整个「运行时配置」里最容易写错的一环：要同时吃下
 * {@code dsh.example.com}、{@code https://dsh.example.com/}、
 * {@code https://dsh.example.com/__pair?code=…} 三种写法，还要挡掉
 * {@code http://}、带端口的越界值、看起来像域名其实不是的东西。
 * 这些都不需要模拟器，直接在这里跑。
 *
 * <pre>
 *   cd android &amp;&amp; ./test-logic.sh
 * </pre>
 */
public final class RemoteConfigTest {

  private static int failed = 0;

  public static void main(String[] args) {
    System.out.println("RemoteConfig.normalizeAuthority");

    // 正常写法
    ok("dsh.example.com", "dsh.example.com");
    ok("  dsh.example.com  ", "dsh.example.com");
    ok("Dsh.Example.COM", "dsh.example.com");
    ok("https://dsh.example.com", "dsh.example.com");
    ok("https://dsh.example.com/", "dsh.example.com");
    ok("https://dsh.example.com/app/session?id=1", "dsh.example.com");
    ok("https://dsh.example.com/__pair?code=ABCD2345&next=%2F", "dsh.example.com");
    ok("dsh.example.com/__pair?code=ABCD2345", "dsh.example.com");
    ok("dsh.example.com:8443", "dsh.example.com:8443");
    ok("https://dsh.example.com:8443/", "dsh.example.com:8443");
    ok("localhost", "localhost");
    ok("localhost:3081", "localhost:3081");
    ok("192.168.1.10:8848", "192.168.1.10:8848");

    // 必须挡掉
    bad("http://dsh.example.com", "明文 http 不该被接受");
    bad("ftp://dsh.example.com", "别的协议");
    bad("", "空串");
    bad("   ", "全空白");
    bad("https://", "没有主机");
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
    bad(null, "null");

    // 子域匹配
    System.out.println("\nRemoteConfig.matchesHost");
    matchOk("dsh.example.com", "dsh.example.com");
    matchOk("Dsh.Example.com", "dsh.example.com");
    matchOk("a.dsh.example.com", "dsh.example.com");
    matchNo("other.example.com", "dsh.example.com");
    matchNo("evildsh.example.com", "dsh.example.com");
    matchNo("example.com", "dsh.example.com");

    System.out.println();
    if (failed == 0) {
      System.out.println("ALL OK");
    } else {
      System.out.println(failed + " FAILED");
      System.exit(1);
    }
  }

  private static void ok(String input, String expected) {
    String actual = RemoteConfig.normalizeAuthority(input);
    if (expected.equals(actual)) {
      System.out.println("ok   " + show(input) + " -> " + actual);
    } else {
      failed += 1;
      System.out.println("FAIL " + show(input) + " -> " + actual + "，期望 " + expected);
    }
  }

  private static void bad(String input, String why) {
    String actual = RemoteConfig.normalizeAuthority(input);
    if (actual == null) {
      System.out.println("ok   " + show(input) + " 被拒（" + why + "）");
    } else {
      failed += 1;
      System.out.println("FAIL " + show(input) + " 应该被拒，却得到 " + actual);
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
