#!/bin/bash
#
# 打 DSH Remote 的安卓壳。不需要 Gradle、不需要 Android Studio，只用 SDK 自带的工具：
#   javac → d8 → aapt2 → zipalign → apksigner
#
# 必填的环境变量：
#   DSH_REMOTE_HOST   手机要连的站点域名（例如 dsh.example.com），不写死进源码
#
# 可选：
#   ANDROID_SDK / ANDROID_HOME   SDK 根目录（默认 ~/Library/Android/sdk）
#   BUILD_TOOLS                  用哪个 build-tools 版本（默认自动挑最新的）
#   PLATFORM                     用哪个 android.jar（默认自动挑最新的 platforms/android-*）
#   VERSION_CODE / VERSION_NAME  默认 11 / 1.10
#   DSH_KEYSTORE                签名用的 keystore 路径；不填就自动生成一个 build/debug.keystore
#   DSH_KEYSTORE_ALIAS          默认 dshremote
#   DSH_KEYSTORE_PASS           默认 dshremote（仅用于自动生成的调试密钥）
#   DSH_KEY_PASS                默认跟 DSH_KEYSTORE_PASS 一样
#
# 用法：
#   DSH_REMOTE_HOST=dsh.example.com ./build.sh
#
set -euo pipefail
cd "$(dirname "$0")"

HOST="${DSH_REMOTE_HOST:-}"
if [ -z "$HOST" ]; then
  echo "错误：没有设置 DSH_REMOTE_HOST（手机要连的站点域名，例如 dsh.example.com）" >&2
  exit 1
fi
case "$HOST" in
  *[!A-Za-z0-9.-]* | .* | *.)
    echo "错误：DSH_REMOTE_HOST='$HOST' 不是合法域名" >&2
    exit 1
    ;;
esac

VERSION_CODE="${VERSION_CODE:-11}"
VERSION_NAME="${VERSION_NAME:-1.10}"
KEY_ALIAS="${DSH_KEYSTORE_ALIAS:-dshremote}"

SDK="${ANDROID_SDK:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
[ -d "$SDK" ] || {
  echo "错误：找不到 Android SDK（$SDK），可用 ANDROID_SDK=... 指定" >&2
  exit 1
}

# 自动挑版本：默认用最新的 build-tools 和 platform
if [ -z "${BUILD_TOOLS:-}" ]; then
  BUILD_TOOLS=$(ls -1 "$SDK/build-tools" | sort -V | tail -1)
fi
BT="$SDK/build-tools/$BUILD_TOOLS"
if [ -z "${PLATFORM:-}" ]; then
  PLATFORM=$(ls -1 "$SDK/platforms" | grep '^android-' | sort -V | tail -1)
fi
AJAR="$SDK/platforms/$PLATFORM/android.jar"
[ -f "$AJAR" ] || {
  echo "错误：找不到 $AJAR" >&2
  exit 1
}
echo "SDK:        $SDK"
echo "build-tools: $BUILD_TOOLS"
echo "platform:   $PLATFORM"
echo "host:       $HOST"
echo "version:    $VERSION_NAME ($VERSION_CODE)"

# ---------------------------------------------------------------- 渲染模板
rm -rf build/classes build/flat build/dex build/gen build/AndroidManifest.xml
mkdir -p build/classes build/flat build/dex build/gen/dev/dshremote/app

render() {
  sed -e "s|@HOST@|$HOST|g" \
      -e "s|@VERSION_CODE@|$VERSION_CODE|g" \
      -e "s|@VERSION_NAME@|$VERSION_NAME|g" "$1"
}

render templates/BuildConfig.java.in > build/gen/dev/dshremote/app/BuildConfig.java
render templates/AndroidManifest.xml.in > build/AndroidManifest.xml

# ---------------------------------------------------------------- 编译
javac -source 8 -target 8 -encoding UTF-8 -classpath "$AJAR" -d build/classes \
  $(find java build/gen -name "*.java")
"$BT/d8" --lib "$AJAR" --release --min-api 26 --output build/dex \
  $(find build/classes -name "*.class")

"$BT/aapt2" compile --dir res -o build/res.zip
unzip -qo build/res.zip -d build/flat
"$BT/aapt2" link -o build/base.apk -I "$AJAR" --manifest build/AndroidManifest.xml \
  $(find build/flat -name "*.flat") -A assets --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"

cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk

# ---------------------------------------------------------------- 签名
# 仓库里不放任何密钥。想发布的话把自己的 keystore 路径给 DSH_KEYSTORE；
# 没给就现生成一个调试密钥（只能自己装，不能上架/更新别人的包）。
if [ -n "${DSH_KEYSTORE:-}" ]; then
  [ -f "$DSH_KEYSTORE" ] || {
    echo "错误：DSH_KEYSTORE 指向的文件不存在：$DSH_KEYSTORE" >&2
    exit 1
  }
  KS="$DSH_KEYSTORE"
  KS_PASS="${DSH_KEYSTORE_PASS:?DSH_KEYSTORE 给了就必须同时给 DSH_KEYSTORE_PASS}"
  KEY_PASS="${DSH_KEY_PASS:-$KS_PASS}"
  echo "签名：       $KS（alias $KEY_ALIAS）"
else
  KS="build/debug.keystore"
  KS_PASS="dshremote"
  KEY_PASS="dshremote"
  if [ ! -f "$KS" ]; then
    echo "签名：       没给 DSH_KEYSTORE，生成一次性调试密钥 $KS"
    keytool -genkeypair -keystore "$KS" -alias "$KEY_ALIAS" \
      -storepass "$KS_PASS" -keypass "$KEY_PASS" \
      -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=DSH Remote Debug" >/dev/null 2>&1
  fi
fi

"$BT/apksigner" sign --ks "$KS" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" \
  --out build/dsh-remote.apk build/aligned.apk

echo
echo "built: build/dsh-remote.apk"
"$BT/apksigner" verify --print-certs build/dsh-remote.apk | head -4
