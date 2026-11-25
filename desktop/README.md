# Minder for macOS

在 Apple 芯片 Mac 上打开 DMG，将 Minder 拖进“应用程序”，然后在 Finder 中双击 Minder。应用内置 Electron、Node.js、SQLite FTS5、Pi 和三个 Minder 扩展。使用者只需在设置里选择资料目录和模型。供应商配置保存在本机，支持选择已有的 Pi 供应商 JSON，也可以连接本机 Ollama。

## 从源码构建

需要 Apple 芯片 Mac、Node.js 24.9 或以上版本、npm 和可用的 macOS 签名与磁盘映像命令。检出发行版仓库，在仓库根目录执行以下命令即可构建桌面应用。

```sh
cd desktop
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npm run package:mac
npm run test:mac
```

`package:mac` 默认读取仓库内的 `releases/minder-0.1.4.tar.gz`。桌面版 0.1.5 使用的运行时版本和归档 SHA-256 固定在 `desktop/package.json` 的 `minderRuntime` 字段中。构建器核对归档、CLI、三个核心包、三个 Pi 扩展及其锁文件，安装生产依赖后使用归档内的类型声明编译桌面代码，再用 esbuild 将前端编译为浏览器可执行的单个 ESM 文件。已有解压目录时，可以运行 `npm run package:mac -- /path/to/delivery`，构建器会把该目录与正式发行归档逐项比对。Electron ZIP 使用官方 npm 包附带的校验值。

构建成功后，`../.minder-dev/macos/latest.json` 记录相对于该目录的应用路径、DMG 路径、映像 SHA-256、签名方式和七个 npm 包的 SHA-512。每次构建拥有独立目录。macOS 验收会校验映像和完整应用签名，实际调用包内 SQLite FTS5，通过 Finder 使用的 Launch Services 启动应用，并在独立配置中操作设置页面。

## 签名

本地构建默认使用 ad-hoc 签名。使用 Developer ID Application 证书时，将证书的完整名称赋给 `MINDER_MAC_SIGN_IDENTITY`。签名方式和 Apple 公证是独立的验证步骤。当前构建脚本仅完成签名和本机验证，未提交 Apple 公证。通过浏览器下载的未公证应用可能触发 Gatekeeper 提示。分发方可在发布前使用自己的 Apple 开发者账号完成公证并将票据装订到映像，然后重新计算发布文件的 SHA-256。

## 来源与许可证

Minder 的桌面代码与 Finder 图标采用仓库根目录的 MIT 许可证。独立实现时参阅了 `vastsa/PI-Desktop`（LGPL-3.0，提交 `649c3456af65d6a105c750a94e57b272d4cf77e9`）的 `apps/desktop/electron/main/entry.ts`、`apps/desktop/electron/preload/index.ts` 和 `apps/pi-host/` 的职责划分。

Electron 采用 MIT 许可证，内含 Chromium 及其他项目的声明。应用在 `Contents/Resources/app/third-party/` 保留 Electron 的许可证及 `LICENSES.chromium.html`，并随生产依赖保留各 npm 包附带的许可证。应用图标源文件为 `assets/icon.svg`，构建时使用 resvg 和 macOS 的 `iconutil` 生成 Finder 图标。

Markdown 显示使用 Marked 18.0.11 和 DOMPurify 3.5.0。应用将这两个包随前端代码分发，分别在 `third-party/marked-LICENSE.txt` 保留 Marked 的 MIT 许可证及版权声明，在 `third-party/dompurify-LICENSE.txt` 保留 DOMPurify 的 Apache-2.0 许可证。两份文件分别来自上述版本随附的 `LICENSE`。
