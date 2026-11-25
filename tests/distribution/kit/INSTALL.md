# Minder 便携安装包

将整个文件夹复制到目标机器，保留 `tarballs/` 及其余文件的位置。CLI 需要 Node.js 22.19 或更新版本和 npm。普通第三方依赖需能访问 npm 注册表或已存在于本地 npm 缓存中。

```sh
npm run verify
npm ci --ignore-scripts
npm run minder -- init
npm run minder
```

`npm run verify` 核对十个归档的 SHA-512。`package-lock.json` 与运行依赖已通过独立目录安装验证。默认安装 CLI、三个 Pi 扩展和三个核心包。三个 DSH 插件的归档用于 DSH 环境的独立安装与分发。
