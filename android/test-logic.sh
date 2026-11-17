#!/bin/bash
# 安卓壳的纯 JVM 自检：不需要模拟器、不需要 Gradle，只要有 JDK。
#
# 覆盖两部分：
#   1. FileTypes        —— 扩展名 → 类型 / MIME（含 .apk 必须被认成安装包）
#   2. RemoteConfig     —— 服务器地址规范化与子域匹配（运行时配置的核心逻辑）
#
# 注意：RemoteConfig 这个类引用了 android.content.Context，所以执行时要把
# android.jar 放在 classpath 上（只是为了让类能加载，跑的都是纯 Java 方法）。
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
if [ -z "${PLATFORM:-}" ] && [ -d "$SDK/platforms" ]; then
  PLATFORM=$(ls -1 "$SDK/platforms" | grep '^android-' | sort -V | tail -1)
fi
AJAR="$SDK/platforms/${PLATFORM:-android-35}/android.jar"

OUT=build/test-classes
rm -rf "$OUT"
mkdir -p "$OUT"

CP=""
if [ -f "$AJAR" ]; then
  CP="$AJAR"
else
  echo "警告：找不到 $AJAR，RemoteConfig 测试可能会加载失败（可用 ANDROID_SDK 指定）" >&2
fi

javac -source 8 -target 8 -encoding UTF-8 ${CP:+-classpath "$CP"} -d "$OUT" \
  java/dev/dshremote/app/FileTypes.java \
  java/dev/dshremote/app/RemoteConfig.java \
  test/FileTypesTest.java \
  test/RemoteConfigTest.java

java -cp "$OUT${CP:+:$CP}" dev.dshremote.app.FileTypesTest
echo
java -cp "$OUT${CP:+:$CP}" dev.dshremote.app.RemoteConfigTest
