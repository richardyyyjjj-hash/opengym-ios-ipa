#!/bin/bash
# 把 openGym 的 iOS 工程编译成 TrollStore 可安装的未签名 IPA。
#
# 前置：macOS + Xcode + CocoaPods + Node 20+ + ldid，且 upstream/ 已克隆好、
#       frontend 依赖已装、web 资源已同步进 ios/（npm run build:mobile）。
#
# 产出（在仓库根目录）：
#   openGym-<ver>-unsigned.ipa        完整包（含全部动作演示动画）
#   openGym-<ver>-lite-unsigned.ipa   精简包（去掉演示动画，体积小很多）
#   以及各自 .sha256
#
# 用法：./scripts/build_ipa.sh [--no-lite]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="$ROOT/upstream"
FE="$UP/frontend"
IOS_APP="$FE/ios/App"

[ -d "$IOS_APP/App.xcworkspace" ] || { echo "!! 找不到 $IOS_APP/App.xcworkspace"; exit 1; }
[ -f "$IOS_APP/App/public/index.html" ] || { echo "!! 缺少 web 资源 $IOS_APP/App/public，先跑 npm run build:mobile"; exit 1; }

VER="$(node -p "require('$FE/package.json').version")"
BUILD="$(sed -n 's/^ *versionCode \([0-9]*\).*/\1/p' "$FE/android/app/build.gradle" | head -1)"
[ -n "${BUILD:-}" ] || BUILD=1
echo "==> openGym $VER (build $BUILD)"

# ---------------------------------------------------------------- 1. 共享 scheme
# 上游只提交了 project.pbxproj，scheme 留在本地 xcuserdata 里没进仓库；
# 干净克隆的 CI 上 `xcodebuild -scheme App` 会直接报 "does not contain a scheme"。
# 这里按 pbxproj 里 App target 的真实 ID 生成一份共享 scheme。
SCHEME_DIR="$IOS_APP/App.xcodeproj/xcshareddata/xcschemes"
if [ ! -f "$SCHEME_DIR/App.xcscheme" ]; then
  TARGET_ID="$(sed -n '/Begin PBXNativeTarget section/,/End PBXNativeTarget section/p' \
    "$IOS_APP/App.xcodeproj/project.pbxproj" \
    | grep -oE '[0-9A-Fa-f]{24} /\* App \*/' | head -1 | cut -d' ' -f1)"
  [ -n "$TARGET_ID" ] || { echo "!! 无法从 pbxproj 解析 App target ID"; exit 1; }
  echo "==> 生成共享 scheme (target $TARGET_ID)"
  mkdir -p "$SCHEME_DIR"
  sed "s/504EC3031FED79650016851F/$TARGET_ID/g" "$ROOT/scripts/App.xcscheme" > "$SCHEME_DIR/App.xcscheme"
fi

# ---------------------------------------------------------------- 2. 编译归档
echo "==> xcodebuild archive"
rm -rf "$ROOT/build" "$ROOT/derived"
cd "$IOS_APP"
set +e
xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/derived" \
  -archivePath "$ROOT/build/App.xcarchive" \
  MARKETING_VERSION="$VER" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_ENTITLEMENTS="" \
  ENABLE_USER_SCRIPT_SANDBOXING=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  archive > "$ROOT/xcodebuild.log" 2>&1
RC=$?
set -e
if [ $RC -ne 0 ]; then
  echo "!! 编译失败，日志尾部："
  tail -80 "$ROOT/xcodebuild.log"
  echo "!! 完整日志：$ROOT/xcodebuild.log"
  exit $RC
fi
tail -5 "$ROOT/xcodebuild.log"

APP="$ROOT/build/App.xcarchive/Products/Applications/App.app"
[ -d "$APP" ] || { echo "!! 归档里找不到 App.app"; find "$ROOT/build" -maxdepth 4 -name '*.app' -print; exit 1; }
echo "==> App.app: $(du -sh "$APP" | cut -f1)"

# ---------------------------------------------------------------- 3. Info.plist 修正
# 模板里 UIRequiredDeviceCapabilities 写的是 armv7；64 位设备上留着它没有意义，
# 侧载校验时还可能被当成不满足条件。直接去掉，不改变应用行为。
/usr/libexec/PlistBuddy -c "Delete :UIRequiredDeviceCapabilities" "$APP/Info.plist" 2>/dev/null || true
echo "==> BundleID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")  Version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")  MinOS=$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$APP/Info.plist" 2>/dev/null || echo '?')"

# ---------------------------------------------------------------- 4. 伪签名
# 只做 ad-hoc 签名（ldid），不做真签名：TrollStore 装的时候会在设备上重签。
# 主二进制和 Pods 里的动态框架都要覆盖，否则 dlopen 会因签名无效被拒。
if command -v ldid >/dev/null 2>&1; then
  echo "==> ldid 伪签名"
  N=0
  while IFS= read -r -d '' f; do
    if [ -x "$f" ] && file -b "$f" | grep -q 'Mach-O'; then
      ldid -S "$f" 2>/dev/null && N=$((N+1)) || true
    fi
  done < <(find "$APP" -type f -print0)
  echo "    已签名 $N 个 Mach-O"
else
  echo "==> 没有 ldid，跳过伪签名（TrollStore 设备端仍会签名）"
fi

# ---------------------------------------------------------------- 5. 打包
pack() { # $1=ipa 路径
  rm -rf "$ROOT/out"
  mkdir -p "$ROOT/out/Payload"
  ditto "$APP" "$ROOT/out/Payload/App.app"
  rm -rf "$ROOT/out/Payload/App.app/_CodeSignature"
  ( cd "$ROOT/out" && zip -qry "$1" Payload )
  rm -rf "$ROOT/out"
}

IPA_FULL="$ROOT/openGym-$VER-unsigned.ipa"
echo "==> 打包完整包"
pack "$IPA_FULL"

IPA_LITE=""
if [ "${1:-}" != "--no-lite" ] && [ -d "$APP/public/exercise-media/clip" ]; then
  LITE_APP="$ROOT/lite-app/App.app"
  rm -rf "$ROOT/lite-app"
  mkdir -p "$ROOT/lite-app"
  ditto "$APP" "$LITE_APP"
  rm -rf "$LITE_APP/public/exercise-media/clip"
  IPA_LITE="$ROOT/openGym-$VER-lite-unsigned.ipa"
  echo "==> 打包精简包（去掉演示动画）"
  rm -rf "$ROOT/out"
  mkdir -p "$ROOT/out/Payload"
  ditto "$LITE_APP" "$ROOT/out/Payload/App.app"
  ( cd "$ROOT/out" && zip -qry "$IPA_LITE" Payload )
  rm -rf "$ROOT/out" "$ROOT/lite-app"
fi

# ---------------------------------------------------------------- 6. 校验
echo "==> 校验产物"
for f in "$IPA_FULL" ${IPA_LITE:+"$IPA_LITE"}; do
  unzip -l "$f" | grep -q 'Payload/App.app/App$' || { echo "!! $f 里没有 Payload/App.app/App"; exit 1; }
  ( cd "$ROOT" && shasum -a 256 "$(basename "$f")" > "$(basename "$f").sha256" )
  echo "    $(basename "$f")  $(du -h "$f" | cut -f1)  $(cut -d' ' -f1 "$f.sha256")"
done

echo
echo "=========================================="
echo " 完成：$IPA_FULL"
echo " 安装：把 ipa 传到 iPhone → 用 TrollStore 打开 → Install"
echo "=========================================="
