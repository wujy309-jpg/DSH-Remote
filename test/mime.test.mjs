import assert from 'node:assert/strict'
import test from 'node:test'
import { asciiFallbackName, contentDisposition, inlineMime, previewMime } from '../relay/mime.js'

test('APK 必须是 package-archive + attachment', () => {
  const mime = previewMime('方寸-v4.2.apk')
  assert.equal(mime, 'application/vnd.android.package-archive')
  assert.equal(inlineMime(mime), false)
  const disposition = contentDisposition('方寸-v4.2.apk')
  assert.match(disposition, /^attachment;/)
  // 中文名走 filename*，浏览器下载下来才叫「方寸-v4.2.apk」
  assert.match(disposition, /filename\*=UTF-8''%E6%96%B9%E5%AF%B8-v4\.2\.apk/)
  // ASCII 兜底也要保住扩展名（只认 filename 的老浏览器才装得上）
  assert.match(disposition, /filename="v4\.2\.apk"/)
})

test('能直接看的类型仍旧 inline', () => {
  for (const name of ['README.md', 'shot.png', 'photo.JPG', 'report.pdf', 'voice.m4a', 'clip.mp4']) {
    const mime = previewMime(name)
    assert.equal(inlineMime(mime), true, `${name} -> ${mime}`)
    assert.match(contentDisposition(name), /^inline;/)
  }
})

test('压缩包 / Office / 未知类型一律 attachment', () => {
  for (const name of ['bundle.zip', '合同.docx', 'book.xlsx', 'slide.pptx', 'unknown.bin']) {
    assert.equal(inlineMime(previewMime(name)), false, name)
    assert.match(contentDisposition(name), /^attachment;/, name)
  }
})

test('纯中文文件名也有可用的 ASCII 兜底名', () => {
  assert.equal(asciiFallbackName('报告.pdf'), 'file.pdf')
  assert.equal(asciiFallbackName('方寸-v4.2.apk'), 'v4.2.apk')
  assert.equal(asciiFallbackName('目录/说明.md'), 'file.md')
  assert.equal(asciiFallbackName('no-extension'), 'no-extension')
})

test('引号/反斜杠不会破坏头', () => {
  const disposition = contentDisposition('a"b\\c.apk')
  assert.match(disposition, /^attachment;/)
  assert.doesNotMatch(disposition, /filename="[^"]*"[^;]/)
})

test('文本类给 text/plain（手机查看器最多）', () => {
  for (const name of ['notes.txt', 'app.ts', 'data.json', 'page.html', 'config.yml', 'src/main.kt']) {
    assert.equal(previewMime(name), 'text/plain; charset=utf-8', name)
  }
})
