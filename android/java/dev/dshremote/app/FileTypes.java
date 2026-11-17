package dev.dshremote.app;

import java.util.Locale;

/**
 * 文件类型判定：MIME、动作面板里显示的中文名、是否适合「直接预览」。
 *
 * 纯 Java（不依赖 Android），这样可以在电脑上用 javac + 一个小 main 直接验证，
 * 不必为了「.apk 认成安装包」这种事去开模拟器。
 *
 * 为什么单独拆出来：APK 必须给 {@code application/vnd.android.package-archive}，
 * 系统安装器和浏览器都靠这个类型决定「这是安装包」；之前一律 octet-stream，
 * 于是「打开方式」里只有一堆莫名其妙的 App，微信也不出现。
 */
public final class FileTypes {

  /** 动作面板/打开方式里用到的粗分类。 */
  public enum Kind {
    TEXT,
    IMAGE,
    PDF,
    AUDIO,
    VIDEO,
    APK,
    ARCHIVE,
    DOCUMENT,
    OTHER
  }

  private FileTypes() {}

  /** 取小写扩展名（不含点）；没有扩展名时返回空串。 */
  public static String extension(String name) {
    if (name == null) return "";
    String base = name;
    int slash = base.lastIndexOf('/');
    if (slash >= 0) base = base.substring(slash + 1);
    int query = base.indexOf('?');
    if (query >= 0) base = base.substring(0, query);
    int dot = base.lastIndexOf('.');
    if (dot < 0 || dot == base.length() - 1) return "";
    return base.substring(dot + 1).toLowerCase(Locale.ROOT);
  }

  /** 是否安卓安装包（按扩展名判断，.apk 足够）。 */
  public static boolean isApk(String name) {
    return "apk".equals(extension(name));
  }

  public static Kind kindOf(String name) {
    String ext = extension(name);
    switch (ext) {
      case "md":
      case "markdown":
      case "txt":
      case "log":
      case "json":
      case "jsonl":
      case "js":
      case "mjs":
      case "cjs":
      case "ts":
      case "tsx":
      case "jsx":
      case "css":
      case "html":
      case "htm":
      case "yml":
      case "yaml":
      case "xml":
      case "sh":
      case "bash":
      case "zsh":
      case "py":
      case "java":
      case "kt":
      case "kts":
      case "go":
      case "rs":
      case "toml":
      case "ini":
      case "conf":
      case "csv":
      case "tsv":
        return Kind.TEXT;
      case "png":
      case "jpg":
      case "jpeg":
      case "gif":
      case "webp":
      case "svg":
      case "bmp":
      case "heic":
      case "heif":
        return Kind.IMAGE;
      case "pdf":
        return Kind.PDF;
      case "mp3":
      case "m4a":
      case "wav":
      case "ogg":
      case "aac":
      case "flac":
      case "opus":
        return Kind.AUDIO;
      case "mp4":
      case "mov":
      case "webm":
      case "mkv":
      case "3gp":
        return Kind.VIDEO;
      case "apk":
        return Kind.APK;
      case "zip":
      case "gz":
      case "tgz":
      case "tar":
      case "7z":
      case "rar":
      case "apks":
      case "xapk":
        return Kind.ARCHIVE;
      case "doc":
      case "docx":
      case "xls":
      case "xlsx":
      case "ppt":
      case "pptx":
        return Kind.DOCUMENT;
      default:
        return Kind.OTHER;
    }
  }

  /** 文本类一律给 text/plain：手机上能打开它的查看器最多。 */
  public static String mimeOf(String name) {
    String ext = extension(name);
    switch (ext) {
      case "md":
      case "markdown":
      case "txt":
      case "log":
      case "json":
      case "jsonl":
      case "js":
      case "mjs":
      case "cjs":
      case "ts":
      case "tsx":
      case "jsx":
      case "css":
      case "html":
      case "htm":
      case "yml":
      case "yaml":
      case "xml":
      case "sh":
      case "bash":
      case "zsh":
      case "py":
      case "java":
      case "kt":
      case "kts":
      case "go":
      case "rs":
      case "toml":
      case "ini":
      case "conf":
        return "text/plain";
      case "csv":
        return "text/csv";
      case "tsv":
        return "text/tab-separated-values";
      case "png":
        return "image/png";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
      case "svg":
        return "image/svg+xml";
      case "bmp":
        return "image/bmp";
      case "heic":
        return "image/heic";
      case "heif":
        return "image/heif";
      case "pdf":
        return "application/pdf";
      case "mp3":
        return "audio/mpeg";
      case "m4a":
        return "audio/mp4";
      case "wav":
        return "audio/wav";
      case "ogg":
        return "audio/ogg";
      case "aac":
        return "audio/aac";
      case "flac":
        return "audio/flac";
      case "opus":
        return "audio/opus";
      case "mp4":
        return "video/mp4";
      case "mov":
        return "video/quicktime";
      case "webm":
        return "video/webm";
      case "mkv":
        return "video/x-matroska";
      case "3gp":
        return "video/3gpp";
      case "apk":
        return "application/vnd.android.package-archive";
      case "apks":
      case "xapk":
      case "zip":
        return "application/zip";
      case "gz":
      case "tgz":
        return "application/gzip";
      case "tar":
        return "application/x-tar";
      case "7z":
        return "application/x-7z-compressed";
      case "rar":
        return "application/vnd.rar";
      case "doc":
        return "application/msword";
      case "docx":
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case "xls":
        return "application/vnd.ms-excel";
      case "xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case "ppt":
        return "application/vnd.ms-powerpoint";
      case "pptx":
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      default:
        return "application/octet-stream";
    }
  }

  /** 手机上「点开就能看」的类型；其余（apk/zip/office/未知）更适合给动作面板。 */
  public static boolean previewable(Kind kind) {
    return kind == Kind.TEXT
        || kind == Kind.IMAGE
        || kind == Kind.PDF
        || kind == Kind.AUDIO
        || kind == Kind.VIDEO;
  }

  /** 动作面板标题下面那行小字。 */
  public static String label(Kind kind) {
    switch (kind) {
      case TEXT:
        return "文本文件";
      case IMAGE:
        return "图片";
      case PDF:
        return "PDF 文档";
      case AUDIO:
        return "音频";
      case VIDEO:
        return "视频";
      case APK:
        return "安卓安装包";
      case ARCHIVE:
        return "压缩包";
      case DOCUMENT:
        return "Office 文档";
      default:
        return "文件";
    }
  }
}
