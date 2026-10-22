# 记忆：项目隔离、本地全文检索增强、任务复盘

- 日期：2026-10-22
- 相关：本设计稿（设计阶段，未实现）；参照 `docs/plans/2026-10-09-context-and-memory.md`、`2026-10-16-bot-handoffs.md`
- 代码基线：`dev` @ `ba9757b`（含 PR #48/#49/#50 的记忆一致性修复）
- 状态：**设计评审通过（R1–R7）；R1 两条注记已按原生 Git 实测撤回改写（修订 9）；R3/R4 复核意见已并入（修订 10）。代码尚未实现，运行测试待实施，未合并、未部署。最终一致性检查由用户进行。**

## 为什么

现有记忆只有两级：Bot 自己的 `MEMORY.md` 与团队记忆。它们跨所有对话、所有项目共享。于是：

- 在项目 A 学到的约定（命令、目录布局、代码风格）会出现在项目 B 的会话里，反之亦然。
- `recall` 只做子串计分（`memory.js:1092-1098`），条目一多就难以命中。
- 任务做完后，经验只靠「记忆整理」顺手捡，缺少「这件事真的做完了」这一环，失败教训尤其容易丢。

本设计补三件事：项目记忆隔离、本地全文检索、任务结束后的经验复盘。三件事都寄生在现有机制上：同一套 Markdown + journal + 提交回滚、同一套 SQLite FTS5 手法、同一条 review 通道。

**明确不做向量**：不引入 embedding、向量库、向量检索、相关 API Key，也不留可选的接口预留。检索只做本地词面检索，不承诺语义理解。

## 已定的行为

### 1. 项目身份（R1）

**解析顺序：Git 永远优先**

```
resolve(cwd) -> { status: 'ok', hash, root, kind: 'git'|'marker'|'self' }
             | { status: 'none' }
             | { status: 'unresolved', reason }
```

1. `realpathSync.native(cwd)`。**以它返回的实际大小写作为唯一键，不做大小写折叠**（见下）。
2. **从 cwd 向上逐层找 `.git`，中途遇到标记物不停。** 这是「Git 优先于仓库内 `package.json`」的落点：monorepo 里 `packages/a/package.json` 不会把子包切成独立项目。
   - `.git` 是目录 → 该目录即元数据目录（主仓库与普通仓库都是这种，且此时**没有** `commondir`）。
   - `.git` 是文件 → 读首行 `gitdir: <path>`。**实测两种写法都有**：本机 git 2.55 写的是**绝对路径 + 正斜杠**（`gitdir: C:/.../worktrees/wt1`），而部分 Git 版本或手写仓库用相对路径。因此解析器**两态都要支持**：`path.isAbsolute(...)` 为真直接取，否则相对 `.git` 文件所在目录解析。再读 `<gitdir>/commondir`（内容是相对路径，如 `../..`，相对 `<gitdir>` 解析）；**没有 `commondir` 就用 `gitdir` 本身**。
   - **必须从 cwd 向上找**：ds-bot 自身就是例子——`ds-bot/` 下面没有 `.git`，仓库根在父目录 `deepseek-bot/.git`。
3. 没找到 `.git` → 从 cwd 向上找**最近的一层**含标记物的目录：`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml`、`*.csproj`。
   - **边界只有两个**：遇到 `teamFolder` 的祖先或盘根即停。**不设层数上限**——同一非 Git 项目的深层目录必须归到同一个根，任意层数上限会把它们切成不同项目。`.git` 搜索同样受这两个边界约束。
4. 都没有：
   - **cwd 等于团队工作区（`folders.js:23` `teamFolder()`）→ `none`**：显式认定为「分组目录」，不是一个项目。`D:\Dev\dsh-plugins` 就是这种：它按 `AGENTS.md` 不建总仓库。
   - **cwd 不是团队工作区 → 以 cwd 自身为根**（`kind: 'self'`），不向上吞并整个盘。
5. `hash = sha256(realpathSync.native(root))` 前 16 位小写 hex。**scope key = `project:<hash>`，目录名 = 纯 `<hash>`**（Windows 目录名不允许冒号）。

**子模块：按实际 common dir 判定，普通子模块独立**

我上一版写「子模块必定有 `commondir` 指父仓库、与父仓库同 id」，**这是错的**。用户在本机用原生 Git 建了真实 submodule 实测（`D:/Temp/2026-10-22-ds-bot-memory-design/git-layout-probe`），我打开该目录复核如下：

| 对象 | `.git` | `commondir` | `git rev-parse --git-common-dir` |
|---|---|---|---|
| 父仓库 `parent/` | 目录 | 无 | `.git`（即 `parent/.git`） |
| 子模块 `parent/sub/` | 文件：`gitdir: ../.git/modules/sub` | **不存在** | `parent/.git/modules/sub` |

因此「普通子模块与父仓库同 id」**没有依据**。规则改为：

- **一律按实际解析出的 common dir 取 hash**，不从 `modules/` 路径反推父仓库，也不对 `modules` 做特殊处理。
- 普通子模块的 common dir 是 `parent/.git/modules/sub` → **独立项目**。
- 同一仓库的 **worktree** 共享同一个 common dir → **同 id**（这条已实测：`.git` 文件 → `gitdir` → `commondir` = `../..` → 主仓库 `.git`）。
- 也就是说，判定只有一条：**解析结果落在同一个 common dir 就是同一个项目**，与目录形状无关。

参考：<https://git-scm.com/docs/gitsubmodules>、<https://git-scm.com/docs/gitrepository-layout>（`modules/` 下是子模块自己的仓库布局）。

**`cwd === teamFolder` 不再直接判 `none`。** 这是 R1 的核心修正：从单仓库启动 DSH 时，团队工作区往往就是那个仓库的根。必须先走第 2、3 步；只有「团队工作区且整条向上链都没有 `.git` 和标记物」才判 `none`。

**Windows 大小写：必须用 `realpathSync.native`，且不折叠**

本机实测（Node 24.20.0，win32）——**两个同名 API 行为不同，这是坑**：

| 输入 | `realpathSync.native` | `realpathSync`（非 native） |
|---|---|---|
| `...\mixedcase` | `...\MiXeDCase` | `...\mixedcase` |
| `...\MIXEDCASE` | `...\MiXeDCase` | `...\MIXEDCASE` |
| `...\MiXeDcAsE` | `...\MiXeDCase` | `...\MiXeDcAsE` |

结论与规则：

- **只用 `realpathSync.native`**。非 native 版本原样保留调用方大小写，用它算 hash 会让同一目录产生多个 id——这是必须避开的实现陷阱。
- native 给出的是磁盘上的**实际大小写**，三种写法已收敛到同一个值，因此**不必再 `toLowerCase()`**。
- **也不能无条件折叠**：Windows 支持按目录启用区分大小写，两个只在大小写上不同的目录可以同时存在且是两个项目，折叠会把它们并成一个。本机 `fsutil file setCaseSensitiveInfo` 需管理员权限、**未能实测**，故按「可能成立」保守处理。
- 顺手剥掉 `\\?\` 长路径前缀再算 hash。
- realpath 失败（目录不存在、不可读）→ `unresolved`，不做「猜测式」兜底。

**缓存**

- `status: 'ok'` 按 cwd 字符串缓存，进程内长期有效。
- **`none` / `unresolved` 只缓存 10 秒**，并在工作文件夹变更、换段（`parts.js:545/720` 的 `renewMemory` 调用点）时清除。这样「同一个 cwd 后来补了 `.git`」不会被永久冻结为错误结论。
- **同步上下文怎么拿到 cwd**：`sectionFor`（`memory.js:838`）当前只收 `sessionId`，且是同步函数，不能 `await rt.resolveAgent`。**但 hook 的上下文里已有 agent**：`memory.js:887` 的 `text: context => sectionFor(context?.agent?.id)`，把签名改成收 `agent` 后，`ctx.sessions.get(agent.id)` 同步可取 `header.cwd`，`folders.js:28-29` 的 `sessionFolder` 与 `workingDirectory.get` 也都是同步的。因此 **project 段可以直接同步进冻结快照，不需要额外缓存层**。
- 仍保留一层 `sessionId → resolve(cwd)` 的进程内缓存，只为省掉每次渲染的 realpath 与目录探测；`none`/`unresolved` 的短过期规则照旧。
- 读数（提示词 section）与写数（`remember`、自动 review、面板）调**同一个函数**，没有第二条算法。

**搬动与重命名**

- `projects.json` 记录 `project:<hash> → 明文路径 + 最后确认时间`，只供显示与提示，不参与判定。
- 路径变了就是新项目。同 basename 只作**提示线索**，不自动合并；由用户确认「复用旧记忆 / 新建」。

### 2. 记忆的可见性与写入范围

| 记忆 | 读 | 写 |
|---|---|---|
| 自己的 `MEMORY.md` + 主题 | 本人 | 本人；Main Bot 在用户要求时可写 |
| 团队记忆 | 所有 Bot | Main Bot、群管理员 |
| 项目记忆（新） | **只有工作在该项目内的会话** | **只有工作在该项目内的会话** |

- Main Bot 的跨 Bot 权限**不延伸到项目记忆**。项目边界是项目，不是 Bot。
- 默认检索范围：有项目 `own + project + team`；无项目 `own + team`。
- 有项目时 `remember` 的**默认写入目标为 project**；`own` 只放跨项目的个人偏好，`team` 只放团队通用。跨项目全局偏好**必须是显式选择或经用户确认**，不是默认。
- 项目未解析（`unresolved`）时**不得静默落进全局 own**：隐式 project 写入一律拒绝并说明原因；`recall` 仍可读 own + team。

**所有第一方写入只有一个判定点**

改默认值和提示词不足以隔离：现有还有硬编码 `ownScope(bot.id)` 的路径。实测行号：

| 写入路径 | 现有代码 | 现状 | 本项目要求 |
|---|---|---|---|
| `remember` / `forget` / `move` | `memory.js:949/985/1008` | 工具参数决定 scope | 有项目时缺省 = project |
| 按回合的自动 review | `memory.js:1417`（读取在 `:1527-1528`） | `ownScope(bot.id)` 硬编码 | 有项目且 `change.team !== true` → project |
| 记忆面板「问或更新」 | `memory.js:1250-1251`（写入在 `:1259`） | 同上硬编码 | 走同一判定点 |
| 记忆面板摘要 | `memory.js:1218-1219`、`:816-819`（`memorySection`） | 只读 own + team | 读 project |
| 面板单条删除 | `memory.js:1290` | 只认 team/own | 增加 project，且只能删该会话所属项目 |
| 删 Bot 归档 | `memory.js:786-803` | `rename` 旁路 | 只归档 own；项目记忆不随 Bot 删除 |

**硬编码 own+team 的位置共五处，必须一起改**：`memorySection:816`、`memoryView:1218`、`memoryAsk:1250`、`reviewSession:1527`、`applyReview:1417`。只在 `remember` 的默认值上加 project，结果是**面板看不到、摘要不含、复盘也写不进** project——这是该默认值的真实成本，不能省。

收成一个函数 `writeScopeOf(sessionId, requested)`，上表路径全部调用它。这样「所有第一方写入」只有一个可被单测穷举的判定点。

- **「不串项目」只保证新写入**；历史 own/team 中的项目内容不在保证范围（见「已知限制」）。

### 3. 任务完成与经验复盘

**四种「结束」必须分开**

| 概念 | 信号 | 是否触发复盘 |
|---|---|---|
| 回合结束 | `agent/status` = `idle` | 否，只作唤醒时机 |
| 换段 / 压缩 | 上下文管家判定；**失败或答不出也换段**，溢出直接换段 | 否，绝不触发 |
| 阶段完成 | Bot 自己的叙述 | 否 |
| 任务验收 | `complete_task` 候选 + 证据核验 | 是 |

管家 `switch` 是上下文管理决策，不是验收：`docs/plans/2026-10-09-context-and-memory.md:43`（溢出直接换段）、`:55`（管家失败换段）都说明它与任务成败无关。复盘**不订阅** `switch`。

**`complete_task` 只是候选**

- 参数：`result`、`claims[]`（每条含 `kind`、`ref`、`statement`）、`notes`。
- `kind`：`answer` / `file` / `command` / `test` / `user`。
- 调用即写 journal `op:'task-candidate'`，**当轮不写任何记忆**。
- **入队时绑定**：`botId`、`sessionId`、`roomId`（群聊时）、解析出的 `project`（或 `unresolved`）。
- **执行前重新校验**：Bot 仍存在、仍是该群成员、会话仍属于该 Bot。**project 的校验分两种，不用「变了就作废」**：
  - 入队 `ok` → 执行时 `ok`：**必须同 hash**，不同则作废（`op:'task-candidate-dropped'`，原因 `project-changed`）。
  - 入队 `unresolved` → 执行时 `ok`：**重绑定到新 hash，不丢候选**（这正是 R1 的 10 秒缓存恢复语义：先跑起来、后补 `.git` 是合法场景）。
  - 入队 `ok` → 执行时 `unresolved`：暂不执行，回到 `WAITING`（不计数、不丢弃）。
  - 入队 `unresolved` → 仍 `unresolved`：`WAITING`。

**证据只看日志，不看模型自报**

- `tool/result` 的结构化字段只有 `message.isError` 与可选 `error{name,code,reason}`（`dsh-session/lib/types/types.d.ts:374-390`、`dsh-tools/lib/types/index.d.ts:197`）。**`exitCode` 不在结构里**，只在模型可见文本中 → 模型自报退出码一律不采信。
- **`isError === false` 不等于任务成功**：读文件成功、跑测试拿到失败报告但工具包装未报错，都是 `isError === false`。

**证据可判定规则（把「原文支持该主张」落成可执行断言）**

「输出原文含支持该主张的结果」「用户原话确有此意」若不给机制，就是语义判断，测试写不出断言。定为**两道闸：第一道纯机械且决定性，第二道模型判定但输出落盘可复核**。

**闸一（机械）**：每条要判 `verified` 的主张必须带 `evidence`，且

- `evidence` 必须是**引用事件正文的逐字子串**。比较前只做两件事：`\r\n` → `\n`、两端 `trim`。正文用 `textOf(event.data.content)` 取（`text.js:11-16`，与 `turns.js:428/452` 同一取法）。
- 长度 8–500 字符。
- **子串不成立 → 直接 `unverified`，不进闸二、不写长期记忆。** 这条完全可单测：构造一个 `tool/result`，断言「evidence 不在输出正文里 ⇒ outcome 不是 verified」。
- `user` 类主张同理：`evidence` 必须是那条 `user/message` 正文的子串。

**闸二（模型判定，结论落盘）**：仅当闸一通过，才发一次小请求（复用 `memory.js:1126` 的 `oneShot` 手法），输入只有「主张原文 + evidence 原文」，只回 `{"support":"yes"|"no"}`。结果连同 evidence 存进条目 `meta`。mock 模型固定回 yes/no 即可覆盖两条路径。

这样「支持与否」仍是一次判断，但它是**被记录、可复核、可 mock 的**判断；而「evidence 不是子串」是机械的，不会漏。

| 主张来源 | 成立条件 | 结论 |
|---|---|---|
| `user` | 锚点存在；`evidence` 是该 `user/message` 正文的子串；闸二 yes | `verified`（记录「用户说过」，不是对世界的断言） |
| `command` / `test` | `callId` 的 `tool/result` 存在；`isError` 为假；`evidence` 是输出正文的子串；闸二 yes | `verified` |
| `command` / `test`（失败教训） | `isError` 为真，或输出正文里有明确的失败行（同样要 `evidence` 子串） | `failed`（写失败教训，标注依据） |
| `file` | 路径在会话工作目录内、存在、类型相符；涉及内容须 `<path>:<片段>` 且片段是文件正文子串 | 有片段 `verified`，仅存在 `unverified` |
| `answer` | 只证明「Bot 这样回答过」 | `unverified` |
| 缺证据 / evidence 不是子串 / 闸二 no | — | **保持候选，不写长期记忆** |

**锚点与文件引用的权限边界**

- 锚点只能在**授权同源日志**里解析：`part N #seq` 经 `rt.partsOf(botId, roomId)`（`parts.js:245-255`）映射到 sessionId，且该 session 必须是本候选所属 Bot 的、或其所在这条会话链上的。**不允许借锚点读别的 Bot 或别的项目的日志。**
- `file` 引用必须落在该会话的工作目录内，按**真实路径 + 目录分隔符**校验，不是字符串前缀匹配（`folders.js:12` 已有 `within()`：`inner === outer || inner.startsWith(outer + sep)`，可直接复用）：
  - 两侧都先 `fs.realpath`，再比；
  - 因此 `../`、`D:\proj` 与 `D:\proj-other` 这种同前缀目录、以及 junction / symlink 越界都被拦住；
  - 越界即 `INVALID`，**不打开该文件**。

**全链路脱敏**

`entryProblem(text)` 只检查条目正文，不够。以下全部在**持久化之前**过 `redactSecrets` + `looksSecret`（`memory.js:596`）：提取计划、摘要、`evidence` 原文摘录、`notes`、条目 `meta`、journal 记录、以及 `task-plans/*.json`。任何一处命中即整条不入库，journal 记 `op:'skip'` 带原因。

**状态机与三类失败**

```
(无) --complete_task--> PENDING
PENDING --条件未满足--> WAITING（不计数、不丢弃）
PENDING --暂时 I/O 失败--> TRANSIENT（独立计数、退避；到上限只告警）
PENDING --语义无效--> 计数，3 次后 SKIPPED（journal 带全文，可人工补记）
PENDING --证据成立--> PLAN_WRITTEN --> APPLYING --> DONE
```

- **`WAITING` 只看本候选自己**：只查本候选所属的 work 与该候选**当前所属 Session** 上的待答卡片。
  - `waits` 的导出名是 **`waitsWork`**（`handoffs.js:71` 定义、`:185` 导出），且它收的是 **work id**，不是 Bot id。`held` 未导出；`waitingView`/`statusOf` 虽导出，但 `waitingView` 走 `held(busyWith(...))`（`:114-117`），会**排除正在回合里的 work**——调用 `complete_task` 的 Bot 此刻正好在回合里，因此**不能拿它当闸门**。需要新增 `pendingWorkOf(botId)`（约 3 行：遍历 `works()`，判 `work.to === botId && work.open.length > 0`）。
  - `state.questions` 以 Session id 为键（`tools.js:543`、`channel.js:272`），换段时 `parts.js:805-808` 把卡片搬到 `freshId`。所以**不能只查候选入队时的旧 sessionId**：还要查该 Bot 当前在用会话（`rt.chatOf(botId)` + `rt.groupSessionsOf(botId)`）里是否有同一 `questionId` 的卡片。**不扫该 Bot 其他群聊里无关的问题。**
- **`WAITING` 的唤醒**：① 事件——子任务交回（`handoffs.js:39` `closeWork`）、问题被回答（`channel.js` 的 `answer-question`）、换段完成；② 重启——启动时扫 `task-plans/` 重建队列；③ 兜底——下一次该会话 idle。
- **候选队列单独落盘，恢复不读 journal**：`task-candidates.json`（temp+rename）。journal 目前只写不读（产品代码只有 `memory-files.js:9/31-71` 的写入），且强杀可能留下半行，**不适合承担恢复**；它只作审计。
- **`memoryReview: false` 同时关闭新复盘**（`memory.js:503` 的 `reviewOn` 是现成开关）。如需分开，再加 `taskReview`，默认取 `reviewOn` 的值。本稿默认跟随，不新增配置项。
- 语义无效复用 `REJECTIONS_MAX = 3`（`memory.js:52`）的量级。

**经验条目的必备结构**

每条写入的条目必须同时含三部分，缺一即不写：

1. **适用条件**：什么时候成立（项目、工具、环境、前提）。
2. **结论或教训**：做成了什么，或为什么失败、下次怎么做。
3. `source`：锚点或 `callId`，可复核。

外加元数据 `outcome`（`verified` / `failed` / `unverified`）与 `evidence`（原文摘录，截断）。`recall` 返回时显示 `outcome`。

**`unverified` 只留在候选里，不进长期库**

- `outcome = unverified` 的条目**不写入** `MEMORY.md` 或任何主题文件，只保留在 `task-plans` 的候选记录与 journal 里，等待补证。
- 补证后再走一次证据核验；那时才写长期记忆。这样「没证据的猜测」不会随着时间变成「记忆」。

**失败证据的边界**

- 失败证据（`isError === true` 或输出原文明确失败）**只能支持「发生了失败」这个断言**。
- **未经证实的根因不能顺带变成 `verified`**：模型说「因为 X 所以失败了」，X 必须有独立证据（日志、输出原文、用户原话）才写；否则根因部分记为 `unverified` 或干脆不写。条目里「发生了什么」与「为什么」要分开标注。

**原回合 review 不得抢先写「成功经验」**

现有按回合 review（`memory.js:1493` `reviewSession`）的提示词必须加一条硬约束：**不得写入任何断言「任务成功」的条目**，除非证据是用户原话，或该会话存在已通过证据核验的 `complete_task` 候选。普通对话里的「我完成了」不算。

**持久化提取计划（R4）**

- **`candidateId` 的确定生成规则**：`candidateId = sha256(sessionId + '\n' + callId)` 的前 32 位小写 hex。只含 `[0-9a-f]`，**天然是安全文件名**，与 `memory.js:509` 的 `safeId` 同理但更严。
- **它去重的是「重放」，不是「模型重发」**：同一份日志重放时 `callId` 不变 → 同一 `candidateId`。但 `callId` 由每次工具调用新生成（`dsh-tools/lib/types/index.d.ts:217`），`turns.js:55-72` 的 retry 是让模型**重新调用**，会拿到新 `callId` → **新候选、新计划**。这类重复靠 `addNow` 的整句全等去重兜底（`memory.js:646-647`，`squash()` 后比较）；**措辞不同不保证**，这一点已在「已知限制」之外单列于下。
- 文件：`task-plans/<candidateId>.json`，**写一次后不可变**：

```json
{ "version": 1, "candidateId": "…", "botId": "…", "sessionId": "…",
  "roomId": null, "project": "project:<hash>|null", "createdAt": "…",
  "items": [
    { "entryId": "sha256(candidateId + ':' + index)[0:16]", "index": 0,
      "scope": "project:<hash>", "topic": "…", "text": "…",
      "line": "- <text> [kind: howto; source: …; added: …]",
      "outcome": "verified", "source": "part 2 #1234",
      "meta": { "kind": "howto", "added": "…" } }
  ],
  "done": [ { "entryId": "…", "file": "ops.md" } ] }
```

- **不可变**：`items` 写定后不再改；恢复只读，**绝不重新调用模型生成新计划**。`done` 是唯一可追加字段，每项记 `entryId` 与**它实际落到的文件**（由 `addNow` 返回值给出，见下）。
- **身份是整行文本，不是字段**：`entryId` 只存在于计划与 `done` 里，**不写进条目行**。所以「该条目是否已落盘」的判定是**按计划里的 `line` 整行文本相等**，不是找 `entryId` 字段。两个内容完全相同的计划项会指向同一行（第二个 `addNow` 返回 `changed:false`，可接受）。
- **写盘方式**：计划写入与 `done` 更新都用 **temp + rename**（`memory.js:115-142` 的手法）。**`done` 只能在对应条目完整写入成功之后追加**。
- **去重优先于「补齐目标文件」——这是防死循环的关键**：`addNow` 的去重是**整 scope** 的（`matchEntries(allEntries(files), text)`，`memory.js:645-646`），不是只查目标文件。若该条目已在**别的主题文件**里，`addNow` 返回 `changed:false`，目标文件永远不会出现那一行。因此规则写死优先级：
  1. `addNow` 返回 `changed:false` → **这一项即 `done`**，并把返回的 `file` 记进 `done`；**不再追写目标 topic**。
  2. `changed:true` → 按返回的 `file` 核对整行，再补 `[[topic]]` 链接，然后 `done`。
  3. 只有「`changed:true` 但目标文件里没有整行」才算异常，按 `replaceEntry` 语义修。
- **逐项恢复，核对两件事**（identity 是整行文本）：
  1. `done` 是否已含该 `entryId`；
  2. 该 `line` 是否已在**任一**该 scope 的已提交文件里（整行相等）。在 → 补 `done`（记实际文件）；不在 → 走上面的 `addNow` 流程。
  `MEMORY.md` 的 `## Index` 里缺该 topic 的 `[[topic]]` 链接时补链接（`memory.js:195` `addLink`）。
- **计划损坏**：`task-plans/*.json` 解析失败 → 原文件改名隔离到 `task-plans/corrupt/<candidateId>.<ts>.json`，journal 记 `op:'task-plan-corrupt'` 并在诊断里报告「需要人工处理」，**不删除、不自动永久 skip、不重做**。
- **人为冲突**：条目被手改成与计划不符（整行对不上且不是 `changed:false` 那条路径）→ 停止该项，记 `op:'task-plan-conflict'`，**不覆盖用户的修改**。
- **project 校验两次，都在计划之外**：计划不可变，`scope` 一旦落盘就固定。因此必须在 **①写计划之前** 与 **②apply 之前** 各校验一次；任一次不一致 → **整份计划作废**（`op:'task-plan-dropped'`，原因 `project-changed`），**不改写计划**。用例 56/57/58 覆盖候选层，计划层另加用例 71。
- **强杀恢复边界**：允许在「文件写成功、`done` 未落盘」之间被杀（靠整行比对判已完成 → 补 `done`）。**不承诺断电场景下 `task-plans/*.json` 自身不损坏**——损坏按上面处理。
- 提交粒度与恢复判定解耦：即使一次 `commit` 提交多条，恢复仍逐项按整行文本判。

**候选队列单独落盘，journal 只作审计**

`journal` 目前**只写不读**（产品代码只有 `memory-files.js:9/31-71` 的写入），而且是无限增长的 append-only；`memory-files.js:31-71` 的截断只发生在同进程 catch 到错误时，**被强杀会留下半行**。因此：

- 恢复队列单独存 `task-candidates.json`（temp+rename，结构化、可整体重写），**不依赖读 journal**。
- journal 仍是审计记录（谁、什么时候、改了什么），**不承担恢复职责**；将来若要读，必须容忍坏行并跳过计数。
### 4. 存储与数据模型

**根目录**：`ds-bot/index.js:52` 是 `const home = config.home ?? join(dshHome, 'bot')`，`memory.js:504` 是 `const root = join(home, 'memory')`。记忆根是 **`<botHome>/memory`**，默认 **`<DSH_HOME>/bot/memory`**。

```
<botHome>/memory/
  bots/<botId>/MEMORY.md + <topic>.md        现有，不动
  team/MEMORY.md + <topic>.md                现有，不动
  projects/<hash>/MEMORY.md + <topic>.md     新增，结构同构；<hash> 16 位 hex，无冒号
  journal.jsonl                              现有；新增 op: task-candidate / task-plan / task-review / skip
  snapshots/                                 现有，按 Session 冻结（加版本与 scope 标识，见 §7）
  reviewed.json / rejections.json            现有
  projects.json                              新增：project:<hash> → 明文路径
  index.sqlite                               新增：可重建的派生索引
  task-plans/<candidateId>.json              新增：不可变的提取计划
  task-candidates.json                       新增：待处理候选队列（temp+rename，恢复不读 journal）
```

**只有这一份派生状态。** 不设 `index-dirty.json`、不设 `index-hashes.json`——理由见 §5。

```sql
CREATE VIRTUAL TABLE entries USING fts5(
  text,            -- 条目正文
  scope UNINDEXED, -- bot:<id> / team / project:<hash>
  file UNINDEXED,  -- 相对 root 的路径
  line UNINDEXED,  -- 行号，回读校验用
  added UNINDEXED, -- 排序用
  tokenize = 'trigram'
);
CREATE TABLE files (
  scope TEXT, file TEXT,
  hash TEXT,       -- 已提交内容的 sha256，一致性判定的唯一依据
  PRIMARY KEY (scope, file)
);
```

`files` 表**只存 hash**，不存 mtime/size——本设计不用 mtime+size 判定新鲜度（同大小同时间戳的改写会漏）。`store.js:30` 的 `stamp()` 是 store 内部常量、未导出；即使将来需要时间戳，`memory-index` 也要自己写，不能引用它。

### 5. 索引一致性（R3）

**改为「每次检索前做一次已提交内容比对」，取消两套派生状态文件。**

1. `recall` 开始时，对**本次允许的 scope** 逐个读文件（经 `memory-files.js:132` 导出的 `read`/`list`，它们覆盖 `pending`、排除回滚），算 `sha256`。
2. **比较完整文件集合**，不只是「已有的文件有没有变」：
   - 索引里有、磁盘上没有 → 在同一事务里**删掉该文件的全部旧行**；
   - 磁盘上有、索引里没有 → 全量插入；
   - 两边都有但 hash 不同 → 删旧行、插新行。
3. 第 1–2 步的所有写入在**同一个 SQLite 事务**内完成：要么整批生效，要么整批回滚，下一次重来。
4. **一致性边界：必须是一段同步块**。`memory.js` 的写入全部经 `queued()` 串行（`memory.js:551-556`，`addNow:638`、`replaceEntry:693`、`removeEntry:711`、`moveEntry:741`、`archiveBotMemory:792` 都在队列里），队列游标是 `writing`（`:551`），两者都是 `install()` 闭包内变量——**`memory-index.js` 拿不到**，必须由 `memory.js` 显式交出「committed 读取器 + 队列空闲信号」两样东西（见 §8 接线清单）。
   刷新流程固定为：`await` 队列空闲 → **一口气同步读完所有可见文件并算 hash**（`readText` 用 `readFileSync`（`memory.js:514-517`）、`list` 用 `readdirSync`，本来就是同步的）→ 期间**不出现任何 `await`**。若索引侧改用 `fs/promises`，`moveEntry` 的第二笔（`:771`）会插进两次读之间，正好采到本设计要避免的中间态（`:767` 写 topic、`:771` 写 `MEMORY.md`）。**这条是硬约束，不是建议。**
5. **索引更新失败**（打不开、写不进、事务失败）→ 直接用第 1 步已经读到内存的那份内容做子串扫描并返回（即现有 `memory.js:1092-1105` 的逻辑），**不再读第二次盘**。下次再试。
6. 启动时同理：索引缺失或版本不符 → 全量建一次；失败则全程走扫描。

**为什么这样能覆盖所有旁路**

这个方案**不需要任何写入钩子**，因此天然覆盖：

- `memory.js:771` 的 `moveEntry` 直接 `writeText(main.path, next)`，不经 `commit`；它随后只写 journal（`:776`）；
- `memory.js:800` 的 `archiveBotMemory` 走 `rename`，随后写 journal（`:801`）；
- 用户手工改写，包括**同大小、同 mtime 的改写**（比 mtime+size 可靠，因为比的是内容）。

**关于「挂在 journal 上」这个备选，明确否掉**

有人会想「journal 是唯一全覆盖的漏斗，把失效钩子挂在 journal 记录上」——`add/replace/remove/move/archive` 确实都写 journal（`:670/704/720/776/801`），且 journal 落地时数据已在盘上。但它有四个问题：

1. journal 目前**只写不读**，没有解析器；
2. `journal()` 失败时 `move` 只 `warn` 不抛（`:777-779`），钩子会静默丢失；
3. 它依赖「每个写路径都记得记一笔 journal」这一约定，未来新增路径容易漏——正是这次 `moveEntry` 暴露的同类问题；
4. 手工改写根本不产生 journal。

内容比对不依赖任何约定，代价是每次读一遍 Markdown。结论：**用内容比对，不用 journal 钩子。**

**这不构成断电原子性保证**：普通 `fs` 写入（`writeText` 的 temp+rename，`memory.js:115-142`）只保证「不会留下半个目标文件」，不保证跨文件、跨 `journal` 的断电一致性。索引侧靠「下次比对内容」自我纠正；记忆侧靠既有 journal 与 `task-plans` 的恢复规则。

**代价：与现状同量级，新增的是哈希**

现有 ecall 已经把每个可见 scope 的全部文件读进内存（memory.js:1071 的 loadScope × N），内容比对**不新增读放大**，新增的只是每个文件一次 sha256。实测（插件工程师提供，本轮未复验）：最坏 3 个 scope 合计约 948 KB，sha256 合计 3.04 ms；单个 67 KB scope 0.08 ms。**这是探针数据，不是产品性能承诺。**

索引在这里的作用是**提供 BM25 排序与跨 scope 检索**，不是省磁盘读；本设计**不声称 I/O 加速**。隔离与正确性优先。

**归档必须显式清索引行**

rchiveBotMemory 是 ename（memory.js:800），scope ot:<id> 从此不在任何检索白名单里。若不做处理，用例 14 会「通过」——但那是**白名单挡住的**，不是行被删了。两种处理，二选一，实现时选定并写注释：

- 在 rchiveBotMemory 里直接 DELETE FROM entries WHERE scope = ?，参数是 ot:<id>（第一方显式清理，不违反「不靠写入钩子」的原则，因为那不是新鲜度判定）；
- 或启动时扫一遍 state.bots，清理已不存在的 ot: scope 行。

**「不靠写入钩子」只管新鲜度判定，不管显式的生命周期清理**——这句要写进代码注释，否则后来者会以为索引行会自动消失。

**排序与过滤**

- 权限过滤在 SQL 层：`scope IN (SELECT value FROM json_each(?))` 先过滤，再 `MATCH`，再 `LIMIT`。**顺序不能倒**——先 LIMIT 再过滤会把别的项目的命中挤掉，返回不足量。
- 这个写法**不会让 FTS 掉出索引扫描**：已实测 `EXPLAIN QUERY PLAN` 仍是 `SCAN e VIRTUAL TABLE INDEX 0:M4`（与纯 `MATCH` 相同）；4000 行下 1.34 ms vs 字面量 `IN` 1.21 ms。**这是探针数据，不是产品性能承诺。**
- 排序两条：`rank`（BM25），同分按 `own > project > team`，再按 `added` 新到旧。

### 6. 检索语义（R7）

以下行为**必须与现有 `recall` 等价**，不能因引入索引而退化：

| 行为 | 要求 |
|---|---|
| 空查询 | 仍返回「存了什么」的目录式列举（数量、大小、主题列表），不报错、不返回空 |
| `topic` 参数 | 仍整份读一个主题，不受索引影响 |
| 全词优先 | 先找含全部词的条目；没有才退化为「含最多词」 |
| 短长混合查询 | ≥3 字走 FTS `MATCH`，1–2 字走 `LIKE`（`chat-index.js:23-42` 的既有手法）。**已实测**（Node 24.20.0 / SQLite 3.53.4）：trigram 下 `"记忆"` 命中 0、`"项目记忆"` 命中 1、英文 `"id"` 命中 0，而 `LIKE '%记忆%'` 命中 1。**`LIKE` 回退是必需项，不是优化** |
| 引号与通配符 | 查询里的 `"` 按 FTS 短语转义（双写）；`%` `_` `\` 按 `LIKE ... ESCAPE '\'` 转义。**一律当字面量**，不当通配符 |
| 排序稳定 | 同分时分档 + 时间，最后按 `file`+`line` 兜底，保证同一查询结果顺序可复现 |
| 出错 | 索引异常必须报「检索暂不可用」或走扫描，**绝不能返回「没有记忆」**——把异常伪装成空结果会误导模型 |

### 7. 缓存与快照隔离（R2）

现有快照只校验 `teamRule`（`memory.js:844-846`），面板摘要以 `botId` 为键（`memory.js:1177-1180`）。加入 project 后两者都会返回旧项目内容。

**快照**

- 快照文件首行加结构标识：`<!-- ds-bot:memory v2 scopes=bot:<id>,project:<hash>,team -->`，scope 集合**排序后**写入。
- `sectionFor` 每次渲染时**同步**现算 scope 集合（`resolve` 是同步的，见 §1），与首行比对：版本或集合不符 → 重建。
- **原有的 `teamRule` 校验必须保留**（`memory.js:844-846`）：角色变化（被设为 Main Bot、或不再是群管理员）会改变规则文本，快照就必须重建。**scope 标识是新增的第二个条件，不能替代它**——两者任一不符都重建。
- **旧快照没有 v2 头** → 视为过期，重建。
- **普通记忆内容更新仍保持现有冻结策略**：同一 Session 内保存的新条目照旧不进本次提示词，靠 `recall` 查。只有 scope 集合变化、角色变化或版本升级才重建。

**面板摘要**

- `summaries` / `summarizing` / `summaryFailures` 的键从 `botId` 改为 `botId + '|' + scopeSetHash`（`hash` 已含内容，这里加的是 scope 集合）。
- 异步回包落地前**比对键**：若当前 scope 集合已变，丢弃这次结果，不写缓存、不写 `summaries/*.json`。
- `summaries/<botId>.json` 内容里带 `scopeSet` 与 `version`；读取时校验，不符视为无缓存。

**面板与 API 的权限（R6）**

- **模型工具不能传 `project` 参数。** `recall` / `remember` / `forget` / `move` 的 project 范围**一律由调用会话同步推导**，没有「传个 hash 就拿到权限」的路径。
- **面板可以由用户显式选项目**，但选择范围是**服务端按该 Bot 的会话归属算出来的列表**；请求只带 `botId` + 列表中的 `project:<hash>`，服务端再校验「该 Bot 确有会话落在该项目」+「目录存在」+「未被配置关闭」。三查全过才落库，任一不过即拒绝并说明，**不静默改写到 own**。
- 异步回包带请求时的 scopeSet 标识，回来后比对，不符即丢弃——防切换串结果。
- **边界声明**：这是**插件记忆 API 的范围隔离**，不是文件系统沙箱。Bot 用文件工具读项目 A 的文件仍然读得到；本项目解决的是「记忆检索与写入不串项目」，不是「Bot 看不见别的项目」。同理，用户显式写进 `own` / `team` 的内容，其**语义**不做硬隔离——那是用户的选择。

### 8. 模块划分

| 文件 | 职责 | 为什么独立 |
|---|---|---|
| `src/host/project-scope.js` | `resolve(cwd)`、`projects.json`、缓存与失效 | 独立失败面（`.git` 文件格式、commondir、大小写、realpath），三方共用，纯函数好单测 |
| `src/host/memory-index.js` | 索引生命周期、内容比对刷新、FTS 查询、重建 | 生命周期与 journal/回滚完全不同；`chat-index.js` 已证明这个模式适合独立成文件 |
| `src/host/task-review.js` | 候选队列、证据核验、计划持久化与恢复 | 异步、模型驱动、可失败可重试，与同步记忆工具解耦 |

`memory.js` 只做接线。**接线清单必须完整，否则索引模块拿不到它需要的东西**：

1. `readScopes` 加上 project；
2. `recall` 的索引优先与扫描回退；
3. 注册 `complete_task`；
4. `writeScopeOf(sessionId, requested)`；
5. **把 committed 读取器交出去**：`memory.js:550` 解构出的 `read`/`list`，`memory-index.js` 自己拿不到；
6. **把写队列空闲信号交出去**：`writing`（`memory.js:551`）也是 `install()` 闭包内变量，要暴露成 `whenWritesSettled()`（返回 `writing`）；
7. 显式清理归档 bot 的索引行（见 §5）。

第 5、6 项是插件工程师复核时指出的漏项：两样东西都是闭包内变量，`memory-files.js:132` 只导出 `memoryFiles()` 的返回值，不会自动出现在 `rt` 上。**不为了少几个文件把独立职责塞进已经 1714 行的 memory.js。**

## 默认行为与故障降级

| 层 | 默认 | 失败时 |
|---|---|---|
| 项目识别 | 自动；Git 优先 | `unresolved` → 拒绝隐式 project 写入，其余功能不受影响 |
| 项目记忆 | 开 | `projectMemory: false` 整体关闭，回到 own + team |
| 全文索引 | 运行时探测：`import('node:sqlite')` + 试建 trigram 表 | 失败 → 永久降级扫 Markdown，进程内不重试 |
| 复盘 | 跟随 `memoryReview` | 三态处理，不阻塞对话、不影响记忆工具 |

## 兼容与迁移

- 现有 own / team 记忆与 journal 一字不动，不自动迁移。
- 项目记忆从空开始；首次检索时索引为空，全量建一次。
- 提示词新增一条：有项目时，项目相关的约定写 project。
- **已知历史污染**：过去写进 own / team 的项目约定无法自动区分。不自动迁移，提供一次性人工整理说明。
- 回退：删 `index.sqlite` 即重建；`projectMemory: false` 立刻回到旧行为。

## 分阶段实施顺序

**运行时可探测，不是人为授权阻塞。** 已实测（本轮，DSH Web 运行时）：DSH Web 进程为 `node C:\Program Files\nodejs\node.exe ... dsh/lib/bin.js web`，Node **24.20.0**；同运行时 `node:sqlite` 可用，SQLite **3.53.4**，`fts5 ... trigram` 建表与 `MATCH` 正常；两字中文词在 trigram 下命中 0，四字词命中 1。这是 runtime 探针，**不是产品已通过测试**。

**桌面端：明确记为「未知」，不按「可用」设计。** 证据：DSH CLI 包 `package.json` 的 `bin` 是 `lib/bin.js`、无 electron 依赖；`lib/bin.js:36` 写明 desktop profile「由 Electron 应用独占管理」；本机 3080 端口由 `node.exe`（PID 40284）提供，`AppData\Local`、`Programs`、`Roaming` 下均无桌面端安装。**因此 `chat-index.js:76` 与 `usage.js:241` 只能证明 Node/Web 侧，不能证明 Electron。** 设计要求：`memory-index` 启动时 `try { await import('node:sqlite') }`，失败则 `warn` 并返回 `null`，主路径回退扫 Markdown（与 `chat-index.js:71-101` 同款）；**验收只写「后端探测失败不崩且回退」，不写「Electron 可用」**。旁证：DSH 自己的 `dsh-session-query-sqlite/lib/index.js:50` 也是 `await import("node:sqlite")`，但它用 `unicode61`，不是 `trigram`。

1. **P1 项目隔离**：`project-scope.js` + project 存储 + `recall`/`remember` 的 scope + 提示词 + `writeScopeOf` 收敛。此时仍用现有子串检索，可独立验收。
2. **P2 全文索引**：`memory-index.js` + 内容比对刷新 + 重建端点 + 运行时探测。
3. **P3 任务复盘**：`complete_task` + `task-review.js` + 证据核验 + 计划持久化与恢复（候选队列独立落盘，不读 journal）。
4. **P4 验收与文档**：补齐用例、`docs/plans` 定稿、README（英文与中文同步）。

每阶段单独 PR，指向 `dev`，不改 `CHANGELOG.md`。

## 明确暂缓

- 向量、embedding、向量库、外部检索框架：**不做，且不留接口**。
- 自动候选复核（把「阶段停顿」猜成完成）。
- 记忆 TTL、自动清理、跨机器同步、自动合并搬动后的项目、Dreaming 式离线整理。
- 任务列表 / 状态面板 / 跨会话任务推进：不建任务管理平台。

## 验收用例

| # | 用例 | 断言 |
|---|---|---|
| 1 | 项目 A 写入，项目 B 会话 `recall` 全量列举 | 零 A 条目；SQL 白名单外不可见 |
| 2 | 同仓库两个 worktree 各写一条 | 落在同一 `projects/<hash>`；相互可见 |
| 3 | **从单仓库根启动 DSH（cwd == teamFolder）** | 解析为该仓库项目，**不是 none** |
| 4 | 分组目录（无 `.git`、无标记物）作为 cwd | `none`，不产生项目记忆 |
| 5 | monorepo 内 `packages/a` 有 `package.json` | 归属外层 Git 仓库，**不切成子项目** |
| 6 | 同 cwd 先无 `.git`，运行中补上 `.git` | 缓存过期后（≤10s）解析为项目，不再冻结为 `none` |
| 7 | Windows 上两个仅大小写不同的真实目录 | 各自独立 id（不折叠） |
| 8 | 同一目录两种大小写写法 | 经 realpath 收敛为同一 id |
| 9 | 中文两字词、三字以上词、英文单词 | 均召回；一字词走 `LIKE` 不报错 |
| 10 | 查询含 `"`、`%`、`_` | 按字面量匹配，不报错、不误配 |
| 11 | 空查询 / `topic` 读取 | 与现有行为一致 |
| 12 | 删除条目后下一次 `recall` | 旧文本不再命中 |
| 13 | `moveEntry`（`memory.js:771`）移动后立即 `recall` | 不命中旧位置，命中新位置 |
| 14 | 删 Bot 归档（`rename` 旁路）后 `recall` | 该 Bot 条目不再出现 |
| 15 | 手工改写文件，**同大小且同 mtime** | 下一次 `recall` 能发现（比的是内容 hash） |
| 16 | 删 `index.sqlite` 后 `recall` | 自动重建，结果一致 |
| 17 | 索引不可用（模拟导入失败） | 回退扫 Markdown，**结果非空或显式报错，二者其一；绝不静默返回空列表** |
| 18 | 管家异常换段（失败 / 溢出两条路径） | 复盘候选为 0，无写入 |
| 19 | 模型谎报完成，日志 `isError === true` | 记为 `failed`；自报 exitCode 不参与判定 |
| 20 | 工具成功但输出显示测试失败 | 不判 verified；无其他证据则保持候选 |
| 21 | 纯问答任务，用户消息确认决定 | 以用户锚点为证据记 `verified`，不强制命令 |
| 22 | 候选跨段引用 `part N #seq` | 经 `partsOf` 映射后可解析；不存在则 `INVALID` |
| 23 | 锚点指向别的 Bot / 别的项目的日志 | 拒绝，`INVALID` |
| 24 | `file` 引用越出会话工作目录 | 拒绝，`INVALID`，不读该文件 |
| 25 | 一条候选 3 条 claims，写完第 1 条后强杀 | 重启后第 2、3 条仍写入；每条恰好一次 |
| 26 | 正文已写、`done` 未落盘时强杀 | 恢复不重复写（靠文件内容判定） |
| 27 | `task-plans/*.json` 损坏 | 整份计划作废并记 `skip`，不重做 |
| 28 | 无变更重复项（`changed:false`） | 该计划项标 `done`，不无限重试 |
| 29 | 子任务未回 / 本会话问题待答 | `WAITING`，不计数、不丢弃；交回后继续 |
| 30 | 该 Bot 另一个群聊有待答卡片 | **不阻塞**本候选 |
| 31 | 重启后队列 | 从 `task-plans/` 与 journal 重建，不丢 |
| 32 | `memoryReview: false` | 新复盘同时关闭 |
| 33 | 三次语义无效 | `SKIPPED`，journal 带全文，可人工补记 |
| 34 | 密钥形态出现在 evidence / notes / meta / 计划文件 | 全部脱敏，不入库 |
| 35 | 自动 review 在有项目的会话里运行 | 写入落 project，不落 own |
| 36 | 面板选项目后切换会话，旧异步摘要返回 | 被丢弃，不串结果 |
| 37 | 面板请求传一个该 Bot 无会话的项目 hash | 拒绝 |
| 38 | 模型工具尝试传 `project` 参数 | 无此参数，范围只能由会话推导 |
| 39 | 快照的 scope 集合变化（换项目/配置关停）后渲染 | 重建，不返回旧项目内容 |
| 40 | 快照的 `teamRule` 变化（Bot 被设为 Main Bot） | 仍重建（原有校验未被 scope 标识替代） |
| 41 | 索引里有、磁盘上已删除/归档的文件 | **同一事务**删除其全部旧行，检索不再命中 |
| 42 | 采集刷新时 `moveEntry` 正在两步之间 | 队列边界等待，不采到中间态（topic 已写、`MEMORY.md` 未写） |
| 43 | `candidateId` 生成 | 仅 `[0-9a-f]`，同一 `sessionId+callId` 恒等 |
| 44 | 计划写入与 `done` 更新期间强杀 | 两者都用 temp+rename；`done` 不早于完整条目提交 |
| 45 | 恢复时正文在但元数据不符 | 视为未完成，按 `replaceEntry` 语义修复，不叠加第二条 |
| 46 | 恢复时缺 `[[topic]]` 链接行 | 补链接（`memory.js:195`），该项标 done |
| 47 | `task-plans/*.json` 损坏 | 改名隔离到 `corrupt/`，报告等待修复，**不删除、不自动永久 skip** |
| 48 | 目标条目被手改成与计划不符 | 停止该项，记 `task-plan-conflict`，不覆盖用户修改 |
| 49 | `file` 引用为 `../`、同前缀目录（`D:\proj` vs `D:\proj-other`）、junction/symlink | 全部 `INVALID`，不打开文件 |
| 50 | 待答卡片随换段搬到新 Session，候选仍记旧 sessionId | 仍判 `WAITING`，不因换段误放行 |
| 51 | `unverified` 的经验 | 只留候选，不进 `MEMORY.md` / 主题文件 |
| 52 | 有失败证据但根因无独立证据 | 只写「发生了什么」为 `failed`，根因不标 `verified` |
| 53 | `evidence` 不是 `tool/result` 正文的子串（模型编的摘录） | 闸一直接判 `unverified`，不调闸二、不写长期记忆 |
| 54 | `evidence` 是子串，闸二回 `no` | `unverified`，不写长期记忆；`meta` 里留下 evidence 与 no |
| 55 | `evidence` 是子串，闸二回 `yes` | `verified`；条目 `meta` 存 evidence 原文与判定结果 |
| 56 | 入队 `unresolved`、执行前补了 `.git` 变 `ok` | 重绑定到新 hash 并继续，**不丢候选** |
| 57 | 入队 `ok`、执行时另一个项目 hash | 作废，`task-candidate-dropped` 原因 `project-changed` |
| 58 | 入队 `ok`、执行时变 `unresolved` | 回 `WAITING`，不计数、不丢弃 |
| 59 | `projectMemory:false` 时面板选项目 | 拒绝（三查里的「未被配置关闭」） |
| 60 | 索引不可用且扫描也失败 | **显式报错**；绝不返回静默空列表 |
| 61 | **真实子模块**（`parent/sub`，`gitdir: ../.git/modules/sub`，无 `commondir`） | 解析到 `parent/.git/modules/sub` → **与父仓库不同的 hash**（已实测，独立项目） |
| 62 | `.git` 文件写绝对路径（git 2.55 的 worktree 形态） | 正确解析 |
| 63 | `.git` 文件写相对路径（子模块形态） | 相对 `.git` 所在目录解析 |
| 64 | cwd 在 `ds-bot/`（`.git` 在父目录） | 向上找到 `deepseek-bot` 仓库根 |
| 65 | 同一目录三种大小写写法 | `realpathSync.native` 收敛为同一 hash；非 native 的写法作为反例被单测拒绝 |
| 66 | 主仓库 `.git` 为目录、无 `commondir` | 直接用该目录，不报错 |
| 67 | `task-candidates.json` 或计划文件损坏 | 计划 → 隔离到 `corrupt/` 并报告；候选队列 → 保留原文件、报告，不静默清空 |
| 68 | 后端无 `node:sqlite`（模拟导入失败） | `warn` + 返回 null + 扫 Markdown；**不崩**（不写「Electron 可用」） |
| 69 | 非 Git 项目，文件在根下第 5 层子目录 | 仍归到同一个根（**不设层数上限**） |
| 70 | 非 Git 项目，cwd 在 `teamFolder` 的祖先侧 | 搜索在 `teamFolder` 边界停止，不越界认出外部项目 |
| 71 | 计划已落盘、apply 前 project 变 hash | **整份计划作废**（`task-plan-dropped`），不改写计划 |
| 72 | 条目已在**别的主题文件**里，恢复时目标 topic 无该行 | `addNow` 返回 `changed:false` → 该项 `done`，记实际文件，**不追写目标 topic**（防死循环） |
| 73 | 恢复时判断「是否已落盘」 | 按计划里的整行文本比对，**不是找 `entryId` 字段** |
| 74 | 强杀留下 journal 半行 | 不影响恢复（恢复不读 journal）；`task-candidates.json` 用 temp+rename |
| 75 | 归档 Bot 后检索 | 该 `bot:` scope 的索引行**被显式删除**，不是只靠白名单挡住 |
| 76 | 刷新期间 `moveEntry` 正处在第 767 行与第 771 行之间 | 同步块内不出现 `await`，不会采到中间态；若改成 `fs/promises` 则该用例失败 |

无法在本阶段验证的：桌面 Electron 端 sqlite（只影响「已验证平台」表述）、崩溃注入点（需实现留钩子）、大小写敏感目录（`fsutil` 需管理员权限）。子模块已由用户实测，不再是未验证项。

## 成本与风险

- 运行成本：索引为本地文件，查询无网络；内容比对与现有 `recall` 同一次读盘、只多一次哈希；复盘每条候选一次模型调用。
- 风险：
  - 项目 id 随路径变化（搬动即新项目）——已定规则，靠提示不自动合并。
  - 词面检索不覆盖同义改写——已知限制。
  - 哈希开销随可见 Markdown 总量线性增长——与现有读盘同量级，换取一致性。
  - 历史 own/team 污染无法自动清理——人工整理。

## 已知限制

- 纯词面检索无法保证「换说法也能找到」。
- `verified` 只表示「有可复核引用且引用支持该主张」，不是客观真理。
- 每次 `recall` 读可见 Markdown 并算哈希：这是设计选择，不是待优化项。
- 项目搬动会产生新 hash，旧记忆需用户确认复用。
- 历史 own/team 中的项目内容不会被自动隔离。
- 记忆范围隔离是插件 API 层的，不是文件系统沙箱。

## 评审状态（R1–R7）

**设计结论：R1–R7 全部通过复审；R1-a/R1-b 已被实测推翻并改写（修订 9）；R3/R4 的复核意见已并入（修订 10）。设计阶段结束，文档冻结，等用户做最终一致性检查。**
**代码：尚未实现；运行测试：待实施。**

| # | 评审问题 | 本稿处置 | 复审方 | 状态 |
|---|---|---|---|---|
| R1 | `cwd==teamFolder` 直接 `none`；Git 与标记物优先级；缓存冻结；Windows 大小写 | §1：先解析 Git/标记物，teamFolder 不再短路；Git 优先；`none/unresolved` 10s 过期；**不折叠大小写**，用 realpath 实际值 | 架构师 | **通过**（附 3 注记） |
| R1-a | 标记物向上搜索无界，上层散落的 `package.json` 会误判 | §1：边界只用 teamFolder 祖先与盘根，**不设层数**（层数上限会把深层目录切成不同项目） | 架构师 | **已撤回并改写**（本轮） |
| R1-b | 子模块归属 | **前一版结论是错的**：普通子模块没有 `commondir`，common dir 是 `parent/.git/modules/sub`。§1 改为「一律按实际 common dir 判定」：子模块独立、worktree 共享 | 架构师 | **已撤回并改写**（本轮） |
| R1-c | 同步 `sectionFor` 拿不到 cwd（`resolveAgent` 是异步） | §1：Session 建立/换段时缓存 `sessionId → resolve(cwd)`，渲染读缓存 | 架构师 | 已收（本轮），仍需实现期验证 |
| R2 | 快照只校验 `teamRule`；面板摘要按 bot 键 | §7：快照首行带版本+排序 scope 集合；摘要键加 scopeSetHash；异步回包比对后落地 | 架构师 | **通过**（附注记） |
| R2-a | scope 标识不能替代原有 `teamRule`/角色校验 | §7 明写：两者任一不符都重建；旧无 v2 头快照视为过期 | 架构师 | 已收（本轮） |
| R3 | `moveEntry:771` 与 `rename` 旁路；两套派生状态 | §5：每次 `recall` 做已提交内容 hash 比对，hash 存 `files` 表，同事务刷新；删除 `index-dirty.json`/`index-hashes.json` | 插件工程师 | **通过** |
| R3-c | 「把失效钩子挂在 journal 上」这个备选是否更好 | §5 明确否掉：journal 只写不读、`move` 写 journal 失败仅 warn（`:777-779`）、依赖「每条路径记得记一笔」的约定、手工改写不产生 journal | 插件工程师 | 已收（本轮） |
| R3-d | `read`/`list` 与 `writing` 都是闭包内变量，索引模块拿不到 | §8 接线清单补第 5、6 项：交出 committed 读取器与 `whenWritesSettled()` | 插件工程师 | 已收（本轮） |
| R3-e | 刷新必须是同步块，否则采到 move 中间态 | §5 第 4 步写成硬约束：同步读完、期间零 `await`，不得改用 `fs/promises` | 插件工程师 | 已收（本轮） |
| R3-f | 归档 Bot 的索引行没人清 | §5：显式删除该 `bot:` scope 行（或启动时清理），并区分「新鲜度不靠钩子」与「生命周期显式清理」 | 插件工程师 | 已收（本轮） |
| R3-g | 「接受读放大」的成本表述不利且不准 | §5：改为「与现状同量级，新增的是哈希」，附探针数据并标注非产品承诺 | 插件工程师 | 已收（本轮） |
| R3-a | 需比较完整文件集合；删除/归档文件要同事务删旧行 | §5 第 2 步写明三种情形（多、缺、变），同一事务 | 插件工程师 | 已收（本轮） |
| R3-b | 刷新可能采到 `moveEntry` 两步中间态 | §5 第 4 步：刷新前 `await` 既有写队列（`memory.js:551-556`）尾部 | 插件工程师 | 已收（本轮） |
| R4 | `entryId` 稳定性依赖计划持久化；journal 不够 | §3：不可变 `task-plans/<candidateId>.json`；恢复只读计划、不再调模型 | 插件工程师 | **通过** |
| R4-g | `addNow` 整 scope 去重会导致「缺行→写行→changed:false」死循环 | §3 写死优先级：`changed:false` 即 done 并记实际文件，不追写目标 topic | 插件工程师 | 已收（本轮） |
| R4-h | journal 只写不读、强杀留半行 | §3：候选队列单独存 `task-candidates.json`（temp+rename），journal 只作审计 | 插件工程师 | 已收（本轮） |
| R4-i | `callId` 每次调用新生成，retry 是模型重发 | §3：明确 `candidateId` 只去重「日志重放」；模型重发是新候选，靠整句全等兜底 | 插件工程师 | 已收（本轮） |
| R4-j | `entryId` 不在条目行里 | §3：身份改述为「计划里的整行文本」，`entryId` 只存在于计划与 done | 插件工程师 | 已收（本轮） |
| R4-k | project 校验时机 | §3：写计划前与 apply 前各校验一次，不一致整份计划作废 | 插件工程师 | 已收（本轮） |
| R4-f | journal 只写不读，无解析器 | ~~新写读端~~ → 修订 10 改为：候选队列单独存 `task-candidates.json`，**不读 journal**（见 R4-h） | 插件工程师 | **已改写**（本轮） |
| R4-a | `candidateId` 生成规则被删 | §3 补回：`sha256(sessionId + '\n' + callId)` 前 32 位 hex，纯安全文件名 | 插件工程师 | 已收（本轮） |
| R4-b | 计划写入/done 更新要 temp+rename，done 不得早于条目提交 | §3 写明；`done` 只在完整条目写成功后追加 | 插件工程师 | 已收（本轮） |
| R4-c | 仅正文存在不足以确认链接与元数据 | §3 恢复核对三项：`entryId`/最终格式整行/`[[topic]]` 链接；缺则补，元数据不符按 `replaceEntry` 修 | 插件工程师 | 已收（本轮） |
| R4-d | 计划损坏不得删除或自动永久 skip | §3：改名隔离到 `corrupt/`，报告等待人工处理 | 插件工程师 | 已收（本轮） |
| R4-e | 人为冲突 | §3：停止该项，记 `task-plan-conflict`，不覆盖用户修改 | 插件工程师 | 已收（本轮） |
| R5 | 候选绑定与重校验；锚点/文件权限；全链路脱敏；WAITING 范围与唤醒；`memoryReview` 联动；经验结构；原 review 抢写 | §3 各段 | 测试工程师 | **通过**（两处已定死） |
| R5-a | 「原文支持该主张」是语义判断，无法断言 | §3 加两道闸：evidence 必须是事件正文逐字子串（机械、决定性），通过后再由模型判 yes/no 且结果落盘 | 测试工程师 | 已收（本轮） |
| R5-b | 「project 变了就作废」与 10 秒缓存恢复冲突 | §3 改为四种转移：`ok→ok` 须同 hash；`unresolved→ok` 重绑定不丢；`ok→unresolved` 回 WAITING；`unresolved→unresolved` WAITING | 测试工程师 | 已收（本轮） |
| R5-c | `file` 边界要防 `../`、同前缀、junction/symlink | §3：两侧 `realpath` + `folders.js:12` 的 `within()` 目录分隔符比较 | 测试工程师 | 已收（本轮） |
| R5-d | 待答卡片换段迁移后不能只查旧 sessionId | §3：查当前在用会话的同一 `questionId`，仍不扫无关群聊 | 测试工程师 | 已收（本轮） |
| R5-e | `unverified` 不得进长期库 | §3：只留候选，补证后再写 | 测试工程师 | 已收（本轮） |
| R5-f | 失败证据不能顺带把未证根因变 verified | §3：发生了什么/为什么分开标注，根因需独立证据 | 测试工程师 | 已收（本轮） |
| R6 | 模型/接口不得传任意 hash；异步防串；边界声明 | §7：模型工具无 `project` 参数；面板只能从服务端列表选；服务器三查；异步带 scopeSet；明确「API 范围隔离 ≠ 沙箱」 | 测试工程师 | **通过** |
| R6-a | 三查里的「未被配置关闭」没有对应用例 | 用例 59：`projectMemory:false` 时面板选项目 → 拒绝 | 测试工程师 | 已收（本轮） |
| R7 | 查询语义不得退化 | §6：七条逐一列明，含 filter 先于 LIMIT、异常不伪装成空结果 | 测试工程师 | **通过** |
| R7-a | 「索引不可用」的断言要更明确 | 用例 17 改为「结果非空或显式报错，二者其一；绝不静默空列表」；另加用例 60 | 测试工程师 | 已收（本轮） |

**外部参考已更正**：固定 commit `6037f8e3b91d657f5eac80ef764b41ce511499dc` 的 `jiuwenswarm/common/coding_memory_paths.py:43–79` 有项目路径隔离；`jiuwenswarm/agents/harness/common/tools/task_tools.py:309–401` 的 `experience_learn` 实际写 `task-data.json`。此前「对方没有实现」的断言删除。**这不等于其任务结果已做证据验收**——本设计的证据核验规则仍是原创补齐。

**无代码或文本复制。** Chief 复核：`git grep` 与全树搜索 `MemoryIndexManager|chunks_vec|chunks_fts|build_fts_query|TodoToolkit|EMBEDDING_CACHE_TABLE|vector_to_blob|list_memory_files|is_memory_path` 均无命中。

**现有代码基线的验证（用户提供，本轮已核对日志）**：隔离工作树下 `npm test` **727/727 通过**、`build-client --check` 通过、`lint` 退出码 0（14 条既有告警）。日志在 `D:/Temp/2026-10-22-ds-bot-memory-design/review-tests.log` 与 `review-lint.log`，本 Chief 已打开确认：`tests 727 / pass 727 / fail 0`，lint 尾部 14 条 warning。**这些只说明现有基线健康，不证明本设计已实现或已通过测试。**

## 变更

- 2026-10-22：初稿。
- 2026-10-22（修订 2）：修正存储根、目录名、单一规范化算法、第一方写入的 project 传递、多 claims 幂等、索引字段。
- 2026-10-22（修订 3）：JiuwenSwarm 引用降级。
- 2026-10-22（修订 4）：收回桌面探针授权阻塞，改运行时探测；面板显式项目上下文；幂等定死逐项恢复；补逐项关闭表。
- 2026-10-22（修订 5）：按 R1–R7 全面修订——项目身份重写（Git 优先、teamFolder 不短路、大小写不折叠、缓存过期）；快照与面板摘要加 scope 版本；索引改为内容比对并删除两套派生状态；提取计划持久化与强杀恢复边界；候选绑定/重校验/全链路脱敏/WAITING 收窄/review 抢写约束；面板与 API 权限边界；查询语义七条。删除「对方没有实现」的断言，改为固定 commit 引用。**该轮评审未通过。**
- 2026-10-22（修订 6）：收架构师 R1/R2 三条注记（标记物搜索加界、子模块归属、同步 cwd 缓存；其中前两条在修订 9 被实测推翻并改写）；收本轮补充检查点：R3 比较完整文件集合 + 队列边界一致视图 + 不断电原子承诺、R4 补回 candidateId 规则与 temp+rename/done 顺序/三项恢复核对/损坏隔离/冲突停止、R5 file 真实路径校验 + 换段后待答卡片 + unverified 不入库 + 失败根因不连带、R2 保留 teamRule 校验。新增 13 条验收用例（40–52）。**评审状态：R1/R2 已通过，R3–R7 待插件工程师与测试工程师交回。**
- 2026-10-22（修订 7）：收测试工程师 R5/R6/R7 复审。把「原文支持该主张」落成两道闸（evidence 逐字子串为机械闸、模型 yes/no 为可复核闸）；project 校验改为四种转移，`unresolved→ok` 重绑定不丢候选；补用例 53–60（evidence 伪造、闸二 no/yes、project 四种转移、`projectMemory:false`、扫描失败显式报错）；用例 17 明确「非空或显式报错，二者其一」。R1/R2/R5/R6/R7 通过，R3/R4 待交回。
- 2026-10-22（修订 8）：收插件工程师 R3/R4 与运行时核实。①桌面端明确记为「未知」，不按可用设计（`lib/bin.js:36` 无 electron 依赖、本机无桌面安装），验收只写「探测失败不崩且回退」；②`realpathSync.native` 与非 native 行为不同的实测表；③`.git` 文件绝对/相对两种写法都要支持（git 2.55 实测为绝对路径）；④否掉「journal 钩子」备选并说明四个理由；⑤journal 只写不读，恢复要新写读端且跳过坏行；⑥五处硬编码 own+team 必须一起改；⑦`waitsWork` 命名与 `waitingView` 不适合当闸门，需新增 `pendingWorkOf`。新增用例 61–68。
- 2026-10-22（修订 9）：按用户原生 Git 实测撤回并改写两处 R1 注记。①**子模块判定错误**：普通子模块 `.git` 为 `gitdir: ../.git/modules/sub`，该 gitdir **没有 `commondir`**，其 common dir 就是 `parent/.git/modules/sub`，与父仓库 `parent/.git` 不同 → 子模块**独立**；改为「一律按实际 common dir 判定，不从 `modules/` 猜父仓库」。worktree 共享 common dir 的结论不变。②**删除「向上最多 3 层」这一无依据限制**，边界只保留 teamFolder 祖先与盘根，避免同一非 Git 项目的深层目录被切成不同项目。用例 61、69、70 相应改写，子模块不再是「未验证项」。
- 2026-10-22（修订 10，本稿）：收插件工程师 R3/R4 复核。**R3**：§8 接线清单补第 5、6 项（committed 读取器、`whenWritesSettled()`，二者都是 `install()` 闭包内变量）；§5 第 4 步写成硬约束「同步块、零 `await`、不得改用 `fs/promises`」；§5 增「归档必须显式清索引行」并区分「新鲜度不靠钩子」与「生命周期显式清理」；成本表述改为「与现状同量级，新增的是哈希」。**R4**：修掉 `addNow` 整 scope 去重导致的死循环（`changed:false` 即 done，不追写目标 topic）；候选队列改存 `task-candidates.json`、**恢复不读 journal**（推翻 R4-f 的旧结论）；明确 `candidateId` 只去重「日志重放」，模型重发是新候选；身份判定改为「计划里的整行文本」；project 在写计划前与 apply 前各校验一次。新增用例 71–76。
