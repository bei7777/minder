# Minder 便携安装包

将整个文件夹复制到目标机器，保留 `tarballs/` 及其余文件的位置。CLI 需要 Node.js 22.19 或更新版本和 npm。普通第三方依赖需能访问 npm 注册表或已存在于本地 npm 缓存中。

```sh
npm run verify
npm ci --ignore-scripts
npm run minder -- init
npm run minder
```

`npm run verify` 核对十个归档的 SHA-512。`package-lock.json` 与运行依赖已通过独立目录安装验证。默认安装 CLI、三个 Pi 扩展和三个核心包。三个 DSH 插件的归档用于 DSH 环境的独立安装与分发。

## 只在 Pi 中启用一项能力

完成上面的 npm 安装后，使用已安装的 Pi 执行 `pi install "/绝对路径/node_modules/pi-minder-snapshot"`。目录应指向便携包解压并安装的位置。重启 Pi 后，输入 `/minder-files` 可以查看文件事务。按需把包名换成 `pi-minder-memory` 或 `pi-minder-firewall`。Pi 使用这个本地目录加载扩展，请保留其位置。

## 只在 DSH 中启用一项能力

DSH 0.2.2-rc.5 需要 Node.js 24.9 或更新版本。选定实际使用的 profile。下例使用名为 `personal` 的 profile。在该 profile 的 `pnpm-workspace.yaml` 保留现有设置，并在 overrides 里指定便携包的核心归档。

```yaml
overrides:
  '@minder/core-snapshot': 'file:/绝对路径/tarballs/minder-core-snapshot.tgz'
```

```sh
dsh plugin --profile personal add '/绝对路径/tarballs/dsh-plugin-minder-snapshot.tgz'
dsh --profile personal --dump-config
```

将绝对路径换成当前便携包的实际路径。使用其他能力时，将核心和插件名称中的 `snapshot` 同时替换为 `memory` 或 `firewall`。这项安装从便携包读取 Minder 自有依赖，从 npm 解析第三方依赖。各插件使用预编译的 ESM 文件。
