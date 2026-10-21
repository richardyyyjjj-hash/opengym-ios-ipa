# openGym → iOS 未签名 IPA（TrollStore 侧载）

把 [openGym](https://github.com/DuarteSantos8/openGym)（React + Capacitor 应用）在 GitHub 的 macOS runner 上编译成**未签名 IPA**，
给 iOS 16.3 / TrollStore 2 的设备侧载安装。不碰苹果开发者账号，不碰 Xcode 图形界面。

## 为什么需要这个仓库

- openGym 的 iOS 原生工程（`frontend/ios/App/App.xcworkspace`）已经在上游仓库里，上游也写了「无签名 IPA」的 CI 配方，
  但它在要求自备 Mac runner 的 GitLab job 里，从没跑通过。
- `xcodebuild` 只能在 macOS 上跑。本仓库只做一件事：把上游代码拉到 macOS runner 上编译、伪签名、打包，产出 `.ipa`。
- TrollStore 需要的是**未签名**（或仅 ad-hoc 签名）的 IPA，它在设备端用 perma-sign 重签。

## 用法

1. Actions → **Build openGym unsigned IPA (TrollStore)** → *Run workflow*
   - `upstream_ref`：上游 tag（默认 `v1.4.1`）
   - `build_lite`：是否同时产出「去掉演示动画」的精简包
2. 等 30–45 分钟
3. 从 Release 或 Artifacts 下载 `openGym-<版本>-unsigned.ipa`
4. 传到 iPhone → TrollStore 打开 → Install

## 构建流程（`.github/workflows/build-ipa.yml` + `scripts/build_ipa.sh`）

```
clone 上游 tag
  → cd frontend && npm ci
  → npm run build:mobile      # VITE_MOBILE 构建 + 动作素材 stage + cap sync（含 pod install）
  → 按 pbxproj 生成共享 scheme（上游没提交，干净克隆必须补）
  → xcodebuild archive  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
  → 去掉 Info.plist 里过时的 UIRequiredDeviceCapabilities(armv7)
  → ldid -S 遍历 App.app 内所有 Mach-O（主二进制 + Pods 动态框架）
  → Payload/ + zip → .ipa（另出 lite 变体）→ sha256
```

## 已知取舍

- **未签名 ≠ 能直接装**：只有 TrollStore（或 AltStore/Sideloadly 用自己的 Apple ID 签）能装；App Store 不行。
- 应用数据和账号体系是 openGym 自己的：首次启动可选「只用本机」或连接自建服务器。
- AGPL-3.0：本仓库只含构建脚本，不含上游源码，源码始终来自上游仓库。
