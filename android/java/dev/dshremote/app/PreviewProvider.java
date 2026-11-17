package dev.dshremote.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 只读的内容提供者：把 App 缓存目录里「从电脑上下载下来的文件」交给系统查看器。
 *
 * 为什么不用 androidx 的 FileProvider：这个壳刻意零依赖（连 Gradle 都不用），
 * 自己实现一个 40 行的 Provider 比引一整套 AndroidX 便宜得多。
 * 限定根目录在 cacheDir/preview，并且只读，不会把 App 私有数据漏出去。
 */
public class PreviewProvider extends ContentProvider {

  public static final String AUTHORITY = "dev.dshremote.app.previews";

  /** 预览文件的唯一目录。 */
  public static File previewDir(android.content.Context context) {
    File dir = new File(context.getCacheDir(), "previews");
    if (!dir.exists()) {
      //noinspection ResultOfMethodCallIgnored
      dir.mkdirs();
    }
    return dir;
  }

  public static Uri uriFor(android.content.Context context, File file) {
    return Uri.parse("content://" + AUTHORITY + "/" + Uri.encode(file.getName()));
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public void attachInfo(android.content.Context context, ProviderInfo info) {
    super.attachInfo(context, info);
    // 不要导出：只有本 App 能读
    if (info.exported) {
      throw new SecurityException("PreviewProvider 不能导出");
    }
  }

  @Override
  public String getType(Uri uri) {
    String name = uri.getLastPathSegment();
    if (name == null || name.isEmpty()) return "application/octet-stream";
    // 别一律给 */*：微信/QQ 这类接收方会按类型决定收不收，APK 也要靠它认成安装包。
    return FileTypes.mimeOf(name);
  }

  @Override
  public Cursor query(
      Uri uri,
      String[] projection,
      String selection,
      String[] selectionArgs,
      String sortOrder) {
    File file = resolve(uri);
    if (file == null) return null;
    String[] columns = {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
    MatrixCursor cursor = new MatrixCursor(columns, 1);
    cursor.addRow(new Object[] {file.getName(), file.length()});
    return cursor;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    File file = resolve(uri);
    if (file == null || !file.exists()) throw new FileNotFoundException(String.valueOf(uri));
    if (!"r".equals(mode)) throw new FileNotFoundException("只读");
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    throw new UnsupportedOperationException("只读");
  }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    throw new UnsupportedOperationException("只读");
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
    throw new UnsupportedOperationException("只读");
  }

  /** 把 content:// 解析回预览目录里的真实文件；越界一律返回 null。 */
  private File resolve(Uri uri) {
    String name = uri.getLastPathSegment();
    if (name == null || name.isEmpty() || name.contains("/") || name.contains("..")) return null;
    File dir = previewDir(getContext());
    File file = new File(dir, name);
    try {
      String root = dir.getCanonicalPath();
      if (!file.getCanonicalPath().startsWith(root + File.separator)) return null;
    } catch (Exception e) {
      return null;
    }
    return file;
  }
}
