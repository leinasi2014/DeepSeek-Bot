<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DeepSeek Bot" width="260">
  </picture>
</p>

# DeepSeek Bot

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-v0.1_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DeepSeek Bot（简称 DS Bot）是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的 bot 插件，插件将 dsh 改造为 bot 形式。你可以与自己创建的 bot 交流、工作。

![和 Chief 说一句话，它就把 bot 和群聊建好](docs/images/team.zh.png)

## 安装

先装好 dsh，并在 dsh 里配好至少一个模型。ds bot 直接使用 dsh 里的模型。

**dsh Desktop（Windows、macOS）**

1. 侧栏点 **插件** → **添加插件**。
2. **包名或地址** 填 `ds-bot`。在中国大陆，**安装源** 选 **中国大陆镜像源**。
3. 点 **安装**，再点 **立即启用**。如果提示“下次启动生效”，完全退出 dsh 再打开。

连不上 npm 时，第 2 步也可以填 [Releases](https://github.com/Fei2411/DeepSeek-Bot/releases) 里下载的 `ds-bot-0.1.7.tgz` 的完整路径，或者 `github:Fei2411/DeepSeek-Bot#v0.1.7&path:/ds-bot`（需要装 Git）。

**dsh Web（Windows、macOS、Linux）**

需要 Node.js `22.19` 以上和 pnpm。

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

**Docker（NAS、Linux 服务器）**

[`docker/`](docker/) 目录构建一个带 dsh Web 和 DS Bot 的镜像，适合 NAS 或其他常开的机器。容器就是 bot 的沙箱：bot 对挂进容器的目录有完全权限，其他的碰不到。见 [`docker/README.md`](docker/README.md)（英文）。

## 配置

我强烈建议你直接通过和 bot 对话来配置其他 bot 和群聊。

## 功能

### Bot

你可以在一个窗口中和一个 bot 完成所有对话和工作，你无需担心背后的上下文问题。你可以在 bot 详情页查看 bot 信息，也可以为 bot 选择你想使用的模型。你可以随时切换模型，但我仍然建议你为一个 bot 长期保持一个模型，仅在真正必要的时刻切换。

另外，bot 拥有记忆，它会记住你的喜好并在下次的工作中应用。你可以在 bot 的详情页管理记忆，也可以直接和 bot 对话来进行管理。

![bot 详情页：模型、记忆、用量](docs/images/details.zh.png)

### 记忆

bot 的记忆分三个范围：

- **它自己**：你和这个 bot 说过的话，以及它了解到的你的习惯。
- **项目**：在某个目录里工作时学到的东西。每个项目一份记忆，一个仓库里的经验不会出现在另一个仓库里。项目由 Git 仓库识别：同一仓库的多个 worktree 算同一个项目，子模块算独立项目；没有 Git 时，以最近的 `package.json` 这类项目文件为准。判断依据是目录里有什么，不是目录叫什么：团队目录本身是 Git 仓库时，它也是一个项目。
- **团队**：团队里所有 bot 共享的内容。

在项目里，bot 读这三个范围，新记忆默认写进项目。另有两种情况，处理方式不同。**没有项目**：目录本身就不属于任何项目——既没有 Git 也没有项目文件，团队目录本身在同样情况下也算这一类——bot 和以前一样只用、只写自己的记忆。**判断不出**：目录看上去有项目，但身份读不出来，比如 Git 元数据里的链接断了、目录打不开；这时 bot 不做猜测，它会拒绝这次保存并说明原因，还会告诉你如果仍要保存就点明 `own` 或 `team`，绝不悄悄退回写到自己的记忆里。拒绝保存说的是你主动要求的保存。任务复盘不同：`complete_task` 只登记一条候选，之后由宿主决定它怎么处理。你也可以指定某一个范围，bot 详情页里可以选择查看哪个项目；项目列表来自这个 bot 自己的会话，所以它无法被指向一个从未工作过的项目。已有记忆不会被搬动或重写，只有新写入的内容按这些规则走。

项目记忆可以在插件配置里用 `projectMemory: false` 关掉：这时不读也不写项目范围的记忆，本该有项目的会话也不会出现项目标签，`own` 和 `team` 在原本允许的地方照常可用。`memory: false` 是整个记忆功能关闭（没有工具、没有提示词段、没有面板）；`memoryReview: false` 是停掉每回合的复盘和任务复盘。这里的隔离指记忆 API 的范围边界，不是文件系统沙箱：bot 仍然能读写你让它碰到的文件。

检索是在你自己的电脑上对你的记忆文件做词面匹配。记忆文件旁边有一个索引，存每条的检索形式；索引建不起来、用不了，bot 就直接读同一份 Markdown，检索照常可用，你手工改过的内容下次检索就会发现。**不使用 embedding 或向量**：换个说法提问，可能找不到那条记忆。要先找到含你提的每一个词的条目，都不满足才退回部分命中；短词长词混着问、以及走扫描时，这条规则同样成立。索引只决定命中与排序，不承诺速度。

任务结束后，bot 可以记下这次学到的东西。`complete_task` 只是提交一份候选，由宿主在回合结束后去看它；回合结束本身不是验收，换段、长对话被压缩、bot 自己说做完了，也都不是。每条主张都要有对应类型的证据：`command` 和 `test` 必须有真实工具结果作证，`user` 必须是你的原话，`file` 必须是从允许读取的文件里引出的原文，`answer` 可以是 bot 之前说过的话——但它只说明 bot 说过，不说明活干成了。每条记录都留一个指向被核对时所用证据的引用，宿主核对不上的主张留在候选里。写入过程中 DSH 被停掉，下次启动会把这份候选按已经固定下来的计划做完，计划里已经写完的条目不重写。候选写过的那行被你自己改过，就停在冲突状态，你的改动保留。记忆满了会把这条留着并告诉你，不会悄悄丢掉。

### Main bot

这个 bot 作为你的 chief，它拥有非常高的权限，可以管理其他 bot 和群聊。第一次进入 ds bot 时，默认会有一个 main bot 叫 Chief。你可以直接和它对话，让它引导你完成配置。

总之，有问题，找 main bot。

### 群聊

ds bot 拥有群聊功能。群聊是非常好的多 bot 协作方式，但它会带来非常明显的费用问题。ds bot 为此特意做了优化：在一个群聊中，你需要设置一个管理员。你的消息默认由管理员回复，它会帮你调用其他 bot。你也可以直接 @ 你需要沟通的 bot，它会直接回应你：输入 @，从列表里选 bot 就行。想让 bot 参考另一段对话，点输入框的 + → 引用对话。

任何 bot 都可以用 @ 把活派给另一个 bot。接活的 bot 自己去做，群聊照常进行。它干活时会在群里同步进度，群聊、侧边栏和它自己的聊天里也能看到它在做什么。做完后，它把结果发到群里，由派活的 bot 接着回应。要停下它的工作，打开群聊详情。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.zh.png)

### 能力

设置 → **能力** 是团队共享的 MCP 服务、技能和能力包列表。在 Bot 设置中启用能力后，从该 Bot 下一条消息开始生效，也适用于它参与的群聊。Bot 添加的本地 MCP 命令需要你先批准才能运行。有其他 Bot 在用的能力，只有你或主 Bot 能修改、删除。

### 用量

在 设置 → 用量 里，可以按时间、按 bot、按模型查看 Token 用量。

![用量页](docs/images/usage.zh.png)

## 数据

所有数据都在你自己的电脑上，在 dsh 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 里。卸载插件不会删除这些数据。

记忆在 `bot/memory/`：各个 bot 的记忆、团队记忆、`projects/` 下每个项目一份，以及检索索引 `index.sqlite`。索引是从 Markdown 文件派生出来的：随时可以删掉，下次检索会重建。还在写入中的任务复盘记录暂存在 `task-plans/`。可以直接手工改这些 Markdown，下次检索会发现。

## 开发

插件源码在 [`ds-bot/`](ds-bot/)。配置项和内部结构见 [`ds-bot/README.md`](ds-bot/README.md)，开发、测试和协作方式见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：ds bot 建在 dsh 的插件系统上。每个 bot 都在 dsh 会话里工作，用的是 dsh 的工具和模型。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 感谢下面这些项目公开的设计思路。ds bot 参考了它们的思路，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：bot 记忆的 Markdown 格式。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言和 @ 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群里一个会话，以及交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite 全文索引搜索聊天记录。
  - [JiuwenSwarm](https://github.com/openJiuwen-ai/jiuwenswarm)：按项目路径的 hash 给每个项目一份记忆目录，以及把任务经验写进任务数据文件。这里只借鉴思路；它的任务经验没有像这里这样按证据验收。
- 每一位试用 ds bot、提问题、报 bug 的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

ds bot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。
