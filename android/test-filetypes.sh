#!/bin/bash
# FileTypes 的纯 JVM 自检：不需要模拟器、不需要 AGP，只要有 JDK。
set -e
cd "$(dirname "$0")"
rm -rf build/test-classes
mkdir -p build/test-classes
javac -source 8 -target 8 -encoding UTF-8 -d build/test-classes \
  java/dev/dshremote/app/FileTypes.java \
  test/FileTypesTest.java
java -cp build/test-classes dev.dshremote.app.FileTypesTest
