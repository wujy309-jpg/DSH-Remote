package dev.dshremote.app;

/**
 * FileTypes 的纯 JVM 自检：不装模拟器也能确认「.apk 被认成安装包」这类事。
 *
 * <pre>
 *   cd android && ./test-filetypes.sh
 * </pre>
 */
public final class FileTypesTest {

  private static int failed = 0;

  private static void check(String name, FileTypes.Kind kind, String mime) {
    FileTypes.Kind actualKind = FileTypes.kindOf(name);
    String actualMime = FileTypes.mimeOf(name);
    boolean ok = actualKind == kind && actualMime.equals(mime);
    if (!ok) failed += 1;
    System.out.println(
        (ok ? "ok   " : "FAIL ")
            + name
            + " -> "
            + actualKind
            + " / "
            + actualMime
            + (ok ? "" : "  (want " + kind + " / " + mime + ")"));
  }

  public static void main(String[] args) {
    check("方寸-v4.2.apk", FileTypes.Kind.APK, "application/vnd.android.package-archive");
    check("APP.APK", FileTypes.Kind.APK, "application/vnd.android.package-archive");
    check("README.md", FileTypes.Kind.TEXT, "text/plain");
    check("docs/项目说明.md", FileTypes.Kind.TEXT, "text/plain");
    check("shot.png", FileTypes.Kind.IMAGE, "image/png");
    check("a.JPG", FileTypes.Kind.IMAGE, "image/jpeg");
    check("report.pdf", FileTypes.Kind.PDF, "application/pdf");
    check("voice.m4a", FileTypes.Kind.AUDIO, "audio/mp4");
    check("clip.mp4", FileTypes.Kind.VIDEO, "video/mp4");
    check("bundle.zip", FileTypes.Kind.ARCHIVE, "application/zip");
    check(
        "合同.docx",
        FileTypes.Kind.DOCUMENT,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    check("Makefile", FileTypes.Kind.OTHER, "application/octet-stream");
    check("v4.2", FileTypes.Kind.OTHER, "application/octet-stream");
    check(
        "dir/name.with.dots.apk?x=1",
        FileTypes.Kind.APK,
        "application/vnd.android.package-archive");

    if (failed > 0) {
      System.out.println(failed + " FAILED");
      System.exit(1);
    }
    System.out.println("ALL OK");
  }
}
