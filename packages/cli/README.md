# Minder CLI

Minder 是基于 Pi SDK 的本地个人助手，包含可撤销的文件修改、可审阅的 Markdown 记忆和本地行动收件箱。需要 Node.js 22.19 或更高版本。

安装发行包后运行 `minder`。向导会要求指定资料目录，并选择本机 Ollama 模型或 DeepSeek API。资料目录与 Minder 私有状态目录必须分开。Ollama 需要已安装且支持工具调用的模型；DeepSeek 可读取 `DEEPSEEK_API_KEY`。通过交互提示保存的密钥位于私有数据目录 credentials.json，采用本机文件权限保护。模型将收到对话和所调用工具返回的材料。

默认终端界面提供对话、File Diff、Undo、Memory Diff 和提醒规则。运行 `minder --help` 查看非交互命令。`minder verify` 用随机文件内容检查实际模型能否成功调用读取工具。离线配置可用 `minder init --root DIR --provider ollama --model MODEL --no-verify`，运行 `minder doctor --json` 查看已启用工具与验证状态。

### 持续跟进委托

在对话里告诉 Minder「帮我跟进论文投稿，下一步核对附件，周五下午三点提醒我」。明确给出要跟进的工作后，助手可以保存标题、备注、下一步、截止时间和跟进时间。重新打开会话后，仍可按标题查看进度、更改时间或标记完成。委托保存在 `MINDER_HOME/tasks/tasks.sqlite`，按资料目录分别管理。

```sh
minder tasks add "论文投稿" --next-step "核对附件" --follow-up "2027-01-15T15:00:00+08:00"
minder tasks list --status open
minder tasks update ID --follow-up "2027-01-18T10:00:00+08:00"
minder tasks show ID
minder tasks complete ID
```

将 `ID` 替换为列表返回的委托标识。时间使用含时区的 ISO 时间，`--due` 设置截止时间，`--follow-up none` 取消跟进时间。多人同时操作同一份本地数据时，可将查到的 `--revision N` 传给更新或完成命令，防止覆盖其他进程已经保存的修改。

`minder watch` 运行期间会检查委托时间。关闭所有监听进程后，委托仍保留在本机；再次启动监听或执行 `minder inbox` 时会补查到期事项。每个时间点只生成一次提醒，投递遵循收件箱的免打扰和冷却规则。`minder tasks check` 检查当前资料目录并列出可以处理的委托卡片。接受行动草稿会将查看进度的请求交给用户处理，委托的完成需要单独确认。

### 使用 Pi 供应商配置

已有 Pi `models.json` 格式的供应商配置时，指定外部文件、其中的供应商标识和模型标识。文件保存在资料目录外，使用普通文件，并保持该文件与其引用路径可用。

```sh
minder init --root ~/Documents/minder-notes \
  --provider-file ~/.config/minder/providers.json --provider dmxapi --model deepseek-flash-guan
minder doctor --json
```

Pi 读取所选模型的接口、服务地址和 `compat` 字段。密钥可以放在外部文件的 `apiKey` 字段，也可以通过该字段引用环境变量。Minder 私有设置只保存文件路径、供应商标识和模型标识。文件路径也可以通过初始化时的 `MINDER_PROVIDER_FILE` 指定。初始化会发送一次真实工具调用验证，使用 `--no-verify` 可保存配置并稍后执行 `minder verify`。

`minder watch --feed URL` 负责监听资料目录、轮询订阅和投递至本地收件箱；保持该命令运行即可在聊天关闭后继续监听。`--score-model MODEL` 允许本机 Ollama 评分；未启用评分时，无明确规则的事件默认归档。`minder rules source URL 5` 将指定订阅设为立即提醒。`minder inbox` 查看卡片，`minder accept ID REV` 将当前草稿保存为已审阅并返回文字。外部发送渠道需要单独实现。

文件事务支持普通文件。基本内容和权限位可还原；特殊文件、ACL、扩展属性、目录树与外部进程直接写入不在当前可恢复范围内。推荐在用户拥有的本地资料目录运行。

`minder permissions` 显示实际资料范围、模型连接方式、文件修改和草稿的授权方式。`minder audit` 列出事件及评分，`minder audit ID` 查看当时生效的规则、投递状态和等待原因。`minder memory history` 列出已接受的修订，`minder memory show ID` 展开其来源和变更内容。
