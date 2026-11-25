# Minder 开发计划与验收标准

Minder 由三个独立 Git 仓库组成。pi-minder 发布三个核心包和三个 Pi 扩展，dsh-plugin-minder 发布三个 DSH 插件，minder 负责 Pi SDK 会话、初始化、审阅和发行。各模块能够单独安装。Minder 自有代码采用 MIT 许可证。

## 依赖与发布

核心使用纯 TypeScript、ESM 和 Node 内置 SQLite。Pi SDK 基线为 1.6.0、Node 22.19；DSH 基线为 0.2.2-rc.5、Node 24.9。开发者使用 pnpm。三仓并排检出，本地联调产物只写入被忽略的 .minder-dev/。Pi 宿主资源使用 peer 依赖，发行版显式装载三个扩展；DSH 使用预编译的 Cordis Bundle。

发布顺序为核心包、两个宿主的插件、发行版。每个版本记录 Git 提交、宿主版本、tarball 完整性摘要和测试环境。检查新目录安装、真实宿主装载、独立包安装，再核对市场条目。Pi 包的关键词包括 pi-package；DSH 包包含 cordis.patch.yml 及 dsh.bundle.patch。社区目录发现和审核与 npm 发布分别验收。公网 minder 名称已由其他项目使用；使用 @minder/cli 也需要对应 scope 授权。

## Phase 1 · 写前快照与撤销

按任务暂存写入，统一读取事务内的数据。优先 CoW，独立副本作为不支持卷的备份方式。不可变备份可按内容去重。覆盖、删除、移动时保存前像；同目录重命名替换。多文件的承诺是逐文件原子替换、整项撤销与中断恢复。宿主暴露 Shell、自定义扩展或 MCP 时，列清受管写入边界。特权和系统目录拒绝访问。超过 500,000,000 字节的原文件只记元信息，须由用户另行授权不可恢复动作。默认限制为五十亿字节、七天。

验收清单：

- 对普通、空、二进制、已移动、重复编辑的真实文件进行逐字节还原。
- 从 Pi 和 DSH 真实工具进入事务。受管会话内读取能看到刚暂存的文件。
- 三个文件中有一个被外部程序修改，撤销应在修改任何文件前报告冲突。
- 提交、撤销过程中终止进程并重启，从日志恢复到可判定状态。
- 大文件、路径逃逸、系统目录、符号链接、Windows junction、并发写入、快照容量及 GC 单独验收。
- 单独安装两个 snapshot 适配器，发行版可显示 File Diff 并一键 Undo。

## Phase 2 · 记忆修订

Markdown 保存长期事实、带到期时间的活动状态和每日摘要；SQLite FTS5 提供可重建的索引。先生成候选，显示新增、覆写、归档及来源；批准时复核原文件版本。Git 式修订保留写前内容，回退产生新修订。

- 单装 Memory 后可提案、查看、接受、拒绝、搜索和回退。
- 同一事实的明确更正只保留一个当前版本；临时偏好保留适用条件与到期时间。
- 外部资料不能自行写入可信档案；手工编辑与旧提案冲突时不丢失用户文字。
- 验证中文短词、索引重建、TTL、重复结束事件与并发审阅。

## Phase 3 · 事件、评分与行动

本地目录、RSS/Atom 提供真实事件。事件保存来源和修订。规则先于可选本地模型；1–3 分归档，4 分汇总，5 分生成行动卡。规则、免打扰、去重、同类冷却和投递回执均可查看。默认卡片为本地审阅操作。独立 watch 进程负责关闭聊天后的持续监听。

- 真实目录和 RSS 变更能在单装 Firewall 的条件下进入记录。
- 分别验证重复事件、跨午夜、延时投递、重启、同卡重复操作。
- 在获授权且人工标注的事件样本上计算低价值事件静默率，目标至少 90%，明确要求提醒的事件均在预期窗口出现。没有标注样本时保留未验证状态。
- 三个宿主入口显示相同的来源、分数、原因和行动内容。

## Phase 4 · 安装与首次使用

首次选择模型、工作目录与通知方式，支持本地 Ollama 探测、API Key 以及真实工具调用验证。终端可审阅文件、记忆和通知，支持显式授予不可恢复操作。演示使用工作区内的真实普通文件。验证干净环境从 tarball 安装、执行、升级与恢复。

平台矩阵为 macOS、Linux、Windows 原生、WSL Linux 卷与 /mnt/c。Windows 验证文件占用、盘符、UNC 与重解析点。CLI 的普通运行只需要受支持的 Node 和 npm；开发构建使用 pnpm。真实模型、远程渠道和市场收录各自记录前提与实际结果，未验证结果不登记为通过。

## 仓库布局与接口

下表中的路径相对于各自仓库。三个核心包只处理本地数据，不导入宿主 SDK。每个宿主负责核实用户身份、确定允许访问的资料目录、区分模型提案和用户操作、接收会话结束或取消事件，以及显示结果。

| 仓库 | 目录 | 负责的工作 |
| --- | --- | --- |
| pi-minder | `packages/core-{snapshot,memory,firewall}/src/` | 文件事务、记忆修订、事件评分与投递，每个包单独编译为 ESM 和 TypeScript 声明 |
| pi-minder | `packages/pi-minder-{snapshot,memory,firewall}/`、`tests/pi-host/` | 注册 Pi 工具与用户命令，将宿主生命周期传给各自的核心，用实际 Pi Session 验证 |
| dsh-plugin-minder | `packages/{snapshot,memory,firewall}/`、`tests/` | 每个包有独立的 Cordis 入口及配置补丁，测试加载 npm 包后的真实 DSH profile |
| minder | `packages/cli/src/{bin,config,session,watch}.ts` | 用户命令、初始化、Pi SDK 会话和独立目录及订阅监听进程 |
| minder | `scripts/lab.mjs`、`tests/distribution/`、`demo/` | 从三个仓库生成 npm 压缩包、逐包校验、安装、升级和记录终端演示 |

| 核心入口 | 宿主传入 | 宿主得到 |
| --- | --- | --- |
| `openSnapshot(options: SnapshotOptions)` | 私有状态目录、允许管理的根目录、可选保护目录和容量上限 | `begin(label)` 返回一次任务的事务，公开 read、write、remove、move、commit、abort。commit、diff 和 undo 返回含路径、变更类型、前后摘要与补丁的 `FileDiff` |
| `new MemoryStore(vaultDir)` | Markdown 目录。每条 `MemoryInput` 指定稳定事实键、层级、正文、来源、意图，并为活动状态提供 expiresAt | propose、diff 产生写前及写后文本。commit 返回修订编号与变更，可按键接受或拒绝。revert 写入反向修订。search 仅检索当前生效的笔记 |
| `new Firewall(stateDir)` | `SourceEvent` 带来源、外部编号、修订、时间、标题、摘要及可选行动草稿。configure 接收优先级、时区、免打扰及冷却规则 | ingest 返回含分数和原因的 `Decision`。dispatchDue 处理到期投递，inbox 提供汇总和行动卡，accept(id, revision) 产生回执，explain 展示评分依据 |

## 本地数据与恢复

默认数据目录为 `~/.minder`，通过 `MINDER_HOME` 可以指定其他目录。放在资料目录外可以将模型允许操作的文件与配置、凭据、索引、历史分开。

| 相对路径 | 保存内容 | 恢复或编辑方式 |
| --- | --- | --- |
| `snapshot/objects/`、`snapshot/journal.sqlite`、`snapshot/writer.sqlite` | 内容按 SHA-256 去重，transactions 记录事务状态，entries 记录更改前后的对象和模式，exceptions 记录大文件操作。writer.sqlite 协调进程间写入 | 事务开始先取得写入权，提交及撤销先逐项检查内容和权限位。进程中断后按日志记录的方向继续，遇到外部冲突时保留现场 |
| `memory/core/`、`memory/active/`、`memory/episodic/`、`memory/archive/` | Markdown 正文及带来源的 YAML 元数据，活动状态含到期时间，每日摘要含会话引用 | 用户可以直接编辑。批准时复核原始摘要，发生冲突则保留用户文字。外部观察只生成待审内容 |
| `memory/.minder/memory.sqlite`、`memory/.minder/index.sqlite` | sessions、proposals、commits 和 episode_cursor 保存审阅与恢复记录。独立的 memory_fts 和 indexed_files 保存检索索引 | 备份 Markdown 及修订数据库。关闭连接后可删除并重建索引，三个字符以下的短词使用子串检索 |
| `firewall/state.sqlite` | events 用来源、外部编号、修订唯一识别事件。decision_policies 保存当时规则，settings 保存当前规则，receipts 保存草稿确认，cursors 和 lease 管理监听进度 | 重启后按到期时间继续投递。重复接受同一修订返回原回执。修改当前规则后，历史记录仍可展示评分时的规则 |

## 构建与各阶段联调

开发机将三个仓库并排放置，每仓先执行 `pnpm install --frozen-lockfile`。Pi 仓内部使用 `workspace:^`，pnpm pack 时改写为已发布版本范围。其余两仓通过工作区根目录的 overrides 指向相邻仓源码包。对外发布的包使用 npm 版本依赖。每次检查压缩包在新目录的安装结果，能够发现本地链接掩盖的入口错误、遗漏的声明文件和依赖。

| 阶段 | 开发者执行的命令 | 必须观察到的结果 |
| --- | --- | --- |
| Phase 1 | 在 pi-minder 执行 `pnpm build`、`pnpm --filter @minder/core-snapshot test`。在 minder 执行 `pnpm lab publish-local @minder/core-snapshot pi-minder-snapshot dsh-plugin-minder-snapshot`。完整发行版使用 `pnpm lab publish-local` 和 `pnpm lab verify-release` | Pi 和 DSH 的工具提交文件，CLI 展示 File Diff，撤销后原文件校验值相同 |
| Phase 2 | 在 pi-minder 执行 `pnpm --filter @minder/core-memory test`。在 dsh-plugin-minder 执行 `pnpm test`。在 minder 执行 `pnpm build`、`pnpm test` | 审阅一个事实，检索已接受文字，编辑 Markdown 后拒绝过期提案，撤销修订能恢复旧内容 |
| Phase 3 | 在 pi-minder 执行 `pnpm --filter @minder/core-firewall test`。在 minder 执行完整 `pnpm lab publish-local`、`pnpm lab test-hosts` 和 `pnpm lab demo record` | 真实目录变更和订阅出现在记录中，符合规则的事件生成可操作卡片，并保存接受回执 |
| Phase 4 | 在 minder 执行 `pnpm lab verify-release`、`pnpm lab test-upgrade <旧版清单路径>`、`pnpm lab kit`、`pnpm lab test-kit`。提供模型后运行 `minder verify` | 干净安装能启动，旧版配置、事务和待审记忆可继续使用。模型验证以实际工具成功读取文件且回答包含随机内容为通过条件 |

## 上游兼容与公开发布

项目使用 `type: "module"`、TypeScript NodeNext 和带 .js 后缀的相对导入。包通过 main、exports、types 声明编译入口。Pi 通过 `keywords: ["pi-package", ...]` 和 `pi.extensions: ["./lib/index.js"]` 登记资源。DSH 使用指向 `./lib/index.js` 的导出、`files: ["lib/", "cordis.patch.yml", "LICENSE"]` 和 `dsh.bundle.patch: "./cordis.patch.yml"`。补丁中的 insert 行以包名加载插件。各包可运行 `pnpm run build`，代码生成由 tsc 完成。

Pi 与 DSH 的工具事件、会话结束时机和人工确认接口由适配器处理。升级时固定新的宿主版本，重新执行真实宿主、取消、独立安装及升级测试。DSH 0.2.2-rc.5 安装时要求显式选择 profile，例如 `dsh plugin --profile web add dsh-plugin-minder-memory@0.1.2`。CLI 在 Pi SDK 会话中只装载三个受管扩展。直接将扩展装入自己的宿主时，同进程内其他插件拥有该进程的系统权限。

公网上架需使用有发布权限的 npm 名称、scope 和公开 Git 仓库地址。填写真实 repository 及包子目录，发布核心、各自插件及 CLI，再分别用干净 profile 检查安装与公共目录的展示版本。DSH 社区 Plugin Hub 和宿主 Discover 的索引来源分别配置。Windows 原生、WSL Linux 文件系统和 Windows 挂载卷分别验证目录链接、文件占用、权限与重命名。CoW 的可用性取决于源和目的卷，复制后实际磁盘占用取决于文件系统。

## 相关开源个人助手

| 项目 | 与 Minder 设计相关的已有实践 |
| --- | --- |
| OpenClaw | 常驻网关、周期任务和投递结果记录。Pi 官方仓库将其列为实际集成案例。[OpenClaw 研究版本](https://github.com/openclaw/openclaw/tree/f47267698a5d9e6170f5cc6dcf47cbdbd9125793) · [Pi 官方仓库](https://github.com/earendil-works/pi) |
| Hermes Agent | 可读的长期记忆、旧会话检索，以及与长期事实分开的可复用技能。[Hermes Agent 研究版本](https://github.com/NousResearch/hermes-agent/tree/1bddac5b8c4afbfafa835460c421a934c7973fec) |
| Khoj | 从个人文档及网页中检索资料，保留可以追查的来源。[Khoj 研究版本](https://github.com/khoj-ai/khoj/tree/ae229ca894c0b80ad84664afcfdde523b5e87057) |
| nanobot | 终端、网页和聊天软件共用助手，借助同一组工具执行任务。[nanobot 研究版本](https://github.com/HKUDS/nanobot/tree/4b352688369996381363af5b5094f69e17a283ca) |
| Leon | 将用户交互、语音输入与可独立扩展的技能分开。[Leon 研究版本](https://github.com/leon-ai/leon/tree/9465e62699e57527764555ee22f2ab281a6510b6) |
