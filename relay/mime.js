/**
 * DSH Remote — 文件下载的 MIME / Content-Disposition 规则。
 *
 * 手机端把文件交给「浏览器 / 系统安装器 / 分享」时，类型决定一切：
 *   - `application/vnd.android.package-archive` → 浏览器和安装器才认 APK；
 *   - `attachment` → 浏览器才会下载，而不是在标签页里摆一个空白页；
 *   - `filename*` → 中文名不丢（ASCII 兜底给只认 `filename` 的老浏览器）。
 *
 * 纯函数，单独放一个文件便于 `node --test` 直接验证（server.js 一被 import 就会 listen）。
 */

/** 文本类一律 text/plain：手机上能打开它的查看器最多。 */
export function previewMime(name) {
  const lower = String(name ?? '').toLowerCase()
  if (/\.(md|markdown|txt|log|json|jsonl|js|mjs|cjs|ts|tsx|jsx|css|html|htm|yml|yaml|xml|sh|bash|zsh|py|java|kt|kts|go|rs|toml|ini|conf)$/.test(lower)) {
    return 'text/plain; charset=utf-8'
  }
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.heic')) return 'image/heic'
  if (lower.endsWith('.heif')) return 'image/heif'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mkv')) return 'video/x-matroska'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.flac')) return 'audio/flac'
  // 安卓安装包必须给这个类型：浏览器「下载完直接安装」、系统安装器都靠它。
  if (lower.endsWith('.apk')) return 'application/vnd.android.package-archive'
  if (lower.endsWith('.zip') || lower.endsWith('.apks') || lower.endsWith('.xapk')) return 'application/zip'
  if (lower.endsWith('.gz') || lower.endsWith('.tgz')) return 'application/gzip'
  if (lower.endsWith('.7z')) return 'application/x-7z-compressed'
  if (lower.endsWith('.rar')) return 'application/vnd.rar'
  if (lower.endsWith('.doc')) return 'application/msword'
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel'
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (lower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint'
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  return 'application/octet-stream'
}

/** 浏览器能直接看/播的才 inline；apk、zip、office 一律 attachment。 */
export function inlineMime(mime) {
  return /^(text\/|image\/|audio\/|video\/)/.test(mime) || mime.startsWith('application/pdf')
}

/** Content-Disposition 的 ASCII 兜底名：老浏览器不认 filename* 时至少有个正经扩展名。 */
export function asciiFallbackName(name) {
  const str = String(name)
  const dot = str.lastIndexOf('.')
  const ext = dot > 0 ? str.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : ''
  let stem = (dot > 0 ? str.slice(0, dot) : str)
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
  if (!stem) stem = 'file'
  return ext ? `${stem}.${ext}` : stem
}

/** 组装响应头里的 Content-Disposition。 */
export function contentDisposition(name) {
  const mime = previewMime(name)
  const kind = inlineMime(mime) ? 'inline' : 'attachment'
  return `${kind}; filename="${asciiFallbackName(name)}"; filename*=UTF-8''${encodeURIComponent(String(name))}`
}
