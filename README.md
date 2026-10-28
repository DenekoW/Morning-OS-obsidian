# Morning OS

> 一个以执行、复盘和连续性为核心的 Obsidian 晨间工作台。

这是基于 [Satya Akhil Galla 的 Morning OS](https://github.com/satyagalla/Morning-OS-obsidian) 定制的研究/工作流版本。它在原有 Home、Inbox、Areas 和 Trash 之上，加入 Focus、任务管线、项目推进、专注计时、Routines、进度记录、Daily Note 工作日志，以及需要审查后才能写入的 AI 助手。

**当前版本：0.6.2 · 需要 Obsidian 1.8.7 或更高版本 · 支持桌面端和移动端**

## 1. 安装与初始化

### 手动安装

1. 在仓库的 `research-workflow` 分支下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在你的库中创建 `.obsidian/plugins/morning-os/`，把这三个文件放进去。
3. 重启 Obsidian，在 **设置 → 第三方插件** 中启用 Morning OS。
4. 点击左侧太阳图标，选择初始化根目录（默认 `Essential`），然后点击 **Initialize system**。
5. 在 **设置 → Morning OS** 中按需调整路径、首页模块、任务行为和 AI 服务。

仓库不包含 `data.json`。首次启用时，插件会使用通用默认设置并在本地生成该文件；你的路径、Areas、API Key 和运行状态不会随源码发布。

### 从源码构建

```bash
npm install
npm test
npm run build
```

构建后，将 `main.js`、`manifest.json`、`styles.css` 复制到上述插件目录。

开发时也可以运行：

```bash
npm run dev      # 监听构建；设置 OBSIDIAN_PLUGIN_DIR 后自动复制
npm run deploy   # 生产构建并复制到 OBSIDIAN_PLUGIN_DIR
```

## 2. 推荐的每日流程

1. **收集**：在 Inbox 快速记录任务，之后再分配到 Area 或 Project。
2. **计划**：在 Morning Planning 查看未完成任务、项目建议和可继续的进度任务，把今天要做的任务加入 Today。
3. **聚焦**：从 Today 的就绪任务中选择 1–3 项加入 Focus，按顺序执行。
4. **推进**：用 Start / Working / Collecting / Complete 管线更新阶段；需要量化推进的任务使用进度和每日目标。
5. **记录**：专注、阅读、Routine、任务进度和完成记录可写入 Daily Note 的 Work Log。
6. **收尾**：在 Shutdown 记录仍挂念的事项，并选择明天的第一项候选任务。

## 3. 核心功能

### Focus：1–3 项执行队列

- Focus 是 Today 的有序子集，不是另一份独立任务清单。
- 只有 Today 中状态为 **Ready** 的任务适合进入 Focus；Waiting 或 Blocked 任务会被移出 Focus。
- 通过任务菜单设置 `Focus #1`、`Focus #2`、`Focus #3`，或用上下按钮调整顺序。
- **Remove** 只移出 Focus，不会把任务移出 Today。
- 点击 **Start** 开始关联任务的专注计时；**+ Focus** 也可开始不关联任务的独立计时。
- 计时支持暂停、继续、完成、附带笔记完成和丢弃。首页会显示当天累计专注时长与次数。

### Today 与任务管线

- Today 是当天完整的承诺清单，分为 Red alert 和 Regular。
- 每项任务都有 **Start → Working → Collecting → Complete** 阶段条。
- **In flight** 汇总所有已进入管线的未完成任务，并按阶段显示数量。
- 点击 Complete 会走正常完成流程；重新打开任务时，管线也会恢复为未完成状态。
- 任务支持子任务、笔记、提醒、项目、Eisenhower 优先级、预计耗时、上下文和执行状态。
- 任务编辑器通过 X、Escape 或背景关闭时会先保存改动；只有 **Discard** 会明确放弃修改。

### Morning Planning：晨间计划

- 汇总此前未完成的任务、项目下一步建议和可继续的进度任务。
- 可设置进度任务的今日增量目标，或把 Backlog 任务加入 Today。
- 如果昨晚在 Shutdown 选择了第一项候选任务，可直接从这里开始。
- 点击 **Complete planning** 记录计划完成状态，并在启用 Daily Note 同步时写入 `Today's Plan`。
- **Plan my day** 会生成可审查的计划提案；AI 不可用时可使用本地、确定性的备用提案。

### Projects：项目推进

- 项目可以独立于任务存在，因此空项目也会保留。
- 每个项目可设置一个明确的 **Next action**，并关联到可编辑任务。
- 从项目创建任务时，可选择 Eisenhower 优先级，以及进入 Backlog 还是 Today。
- 支持编辑、重命名和删除项目。删除项目不会删除任务或 Routine，只会清除它们的项目关联。
- **Review project** 和 **Weekly review** 通过 AI 提案辅助复盘，写入前需要确认。

### Routines、阅读与进度

- Routine 支持 Daily / Weekly 周期，以及 Check / Duration / Count 三种计量方式。
- 可设置目标、单位并关联项目；支持记录进度和修正累计值。
- 阅读记录区分 **Read** 与 **Skim**；只有 Read 计入每周阅读目标。
- 任务可设置总量型进度（当前值、目标值、单位）和每日增量目标。
- **Log progress** 支持增加进度或直接设置总进度；达到总目标前，进度任务不能直接完成。

### Shutdown：收工与明日连续性

- 汇总当天专注时长和会话次数。
- 记录 `Still on my mind`，并选择 `Tomorrow’s first task candidate`。
- 点击 **Close the day** 保存状态；启用 Daily Note 同步时，同时写入 Shutdown 区块。

### Inbox、Areas 与 Trash

- **Inbox**：快速捕获，之后再整理。
- **Areas**：按生活或工作领域组织任务、目标和笔记；支持自定义标签页、字段、卡片或表格视图。
- **Trash**：软删除任务，避免误删后立即丢失。
- 任务文本中的 `[[链接]]` 和 `#标签` 可渲染并支持输入补全。

## 4. AI 功能与安全边界

### 可选提供商

OpenAI、DeepSeek、Google Gemini、Groq、AWS Bedrock。

在 **设置 → Morning OS → AI provider** 选择服务并填写凭据。模型 ID 可按服务要求调整。

### 没有 API Key 时

- 关闭 **Use AI for briefings** 后，简讯可直接从本地库内容生成，不联系 AI 服务。
- 本地任务、Focus、Projects、Routines、计时、进度和 Daily Note 功能仍可使用。
- Plan my day 提供本地备用计划；其他需要模型理解或生成的功能需要可用凭据。

### 写入前审查

- Plan my day、Review project、Weekly review 返回结构化提案，不会直接改写任务。
- 提案以任务标题、项目和优先级展示，隐藏内部任务 ID。
- 只有经过校验并在审查窗口中确认的变更才会应用。
- Morning Planning 中的 **Ask AI** 支持查询和任务操作；写操作按风险确认，并记录到 Recent AI activity，可执行 Undo。

### 数据与凭据

- 不启用 AI 时，简讯在本地生成。
- 启用 AI 后，与当前功能相关的任务、项目、目标或已配置 Area 内容会发送给所选提供商；插件不会把整个库作为提示词上传。
- API Key 保存在 Obsidian 的本地 `data.json` 中。**不要提交、分享或截图公开该文件。**
- 本仓库已忽略 `data.json`，源码中的凭据字段均为空。

## 5. 文件与同步

主要文件如下，路径均相对于库根目录：

```text
00-MOC/Morning OS Tasks.md       # Markdown 任务注册表
_generated/briefs/               # 每日简讯
_generated/activity-state.json   # Routines、专注和阅读状态
_generated/progress-events.json  # 任务进度事件
_generated/project-state.json    # 项目状态与 Next action
_generated/workflow/             # 每日 Planning / Shutdown 状态
_generated/ai-task-activity.json # AI 任务操作与撤销记录
_generated/backups/              # 迁移和恢复备份
Essential/Daily/YYYY-MM-DD.md    # 默认 Daily Note 目录，可配置
```

Daily Note 同步由 **Task behavior → Sync tasks to today’s Daily Note** 控制。任务区块只更新已经存在的当天日记；计划、工作日志和 Shutdown 服务会按功能需要创建当天日记。若 Obsidian 的 Daily Notes 核心插件配置了目录，该目录优先于 Morning OS 中的备用目录。

任务注册表是可读的 Markdown。手动编辑时请保留每项下方的 `morning-os` 元数据注释。外部工具或同步程序修改注册表后，插件会自动重新加载并刷新视图。

也可以通过以下 URL 从外部工具打开 Morning OS：

```text
obsidian://morning-os?vault=<URL 编码后的库名>
```

## 6. 从旧版本迁移

如果你从 0.2.x 或早期基于 Daily Note 的版本升级：

1. 先备份整个库。
2. 在 **设置 → Morning OS → Vault migration** 执行 **Migrate vault to areas**。
3. 检查 Areas、任务、目标和 Wins 是否完整。

迁移是可重复执行的，旧文件会归档到 `_archive/pre-migration/`。已有 `_generated/tasks.json` 会迁移为 Markdown 注册表；恢复 Area 信息前会保留备份。

## 7. 隐私友好的仓库约定

- `data.json`、依赖目录、环境文件和本地代理配置均不纳入版本控制。
- 文档和测试只使用通用示例，不包含个人库路径、真实项目名、任务内容或凭据。
- 发布前运行 `npm test` 和 `npm run build`，并检查构建产物中没有环境变量注入的代理地址或密钥。

完整版本变化见 [CHANGELOG.md](CHANGELOG.md)。原始项目与许可证归原作者所有，本分支保留 MIT License。
