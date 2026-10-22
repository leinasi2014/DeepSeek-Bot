# 记忆：项目隔离、本地全文检索增强、任务复盘

- 日期：2026-10-22
- 相关：本设计稿（设计阶段，未实现）；参照 `docs/plans/2026-10-09-context-and-memory.md`、`2026-10-16-bot-handoffs.md`
- 代码基线：`dev` @ `ba9757b`（含 PR #48/#49/#50 的记忆一致性修复）
- 状态：**设计评审中。** R1/R2/R5/R6/R7 已通过本轮复审，R3/R4 待插件工程师交回；代码未实现、运行测试未实施、未合并、未部署。

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
   - `.git` 是目录 → 该目录即元数据目录。
   - `.git` 是文件 → 读首行 `gitdir: <path>`（相对路径相对 `.git` 所在目录）；再读 `<gitdir>/commondir`（相对 `<gitdir>`）得 common dir；**没有 `commondir` 就用 `gitdir` 本身**（子模块、`--separate-git-dir`）。
3. 没找到 `.git` → 从 cwd 向上找**最近的一层**含标记物的目录：`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml`、`*.csproj`。
   - **有界**：遇到 `teamFolder` 或盘根即停，且**向上最多 3 层**。理由：一个被随手丢在 `D:\Dev` 或更上层的 `package.json` 会把分组目录误判成项目根。**`.git` 搜索不受此限**——Git 自身的目录结构就是它的界。
4. 都没有：
   - **cwd 等于团队工作区（`folders.js:23` `teamFolder()`）→ `none`**：显式认定为「分组目录」，不是一个项目。`D:\Dev\dsh-plugins` 就是这种：它按 `AGENTS.md` 不建总仓库。
   - **cwd 不是团队工作区 → 以 cwd 自身为根**（`kind: 'self'`），不向上吞并整个盘。
5. `hash = sha256(realpathSync.native(root))` 前 16 位小写 hex。**scope key = `project:<hash>`，目录名 = 纯 `<hash>`**（Windows 目录名不允许冒号）。

**子模块：有 `commondir` 就归父仓库**

子模块的 `.git` 文件指向 `<parent>/.git/modules/<name>`，该目录下有 `commondir` 指向父仓库。按上面的规则会解析到**父仓库根**，即子模块与父仓库共用一个 project id。这是有意的：子模块是父仓库记录的一次 checkout，项目约定本该共享。这一条明确写下，避免实现者自行发挥。

**`cwd === teamFolder` 不再直接判 `none`。** 这是 R1 的核心修正：从单仓库启动 DSH 时，团队工作区往往就是那个仓库的根。必须先走第 2、3 步；只有「团队工作区且整条向上链都没有 `.git` 和标记物」才判 `none`。

**Windows 大小写：不折叠**

`realpathSync.native` 已经返回本机的实际大小写，那才是这个目录的真实名字。Windows 支持按目录启用区分大小写，两个只在大小写上不同的目录可以同时存在且是两个项目。因此：

- **不对 realpath 结果做 `toLowerCase()`**，直接用它作键。
- 同一目录的不同写法（`D:\DEV\x` 与 `d:\dev\x`）经 realpath 后收敛到同一个实际大小写，自然同 id——不需要折叠也行。
- realpath 失败（目录不存在、不可读）→ `unresolved`，不做「猜测式」兜底。

**缓存**

- `status: 'ok'` 按 cwd 字符串缓存，进程内长期有效。
- **`none` / `unresolved` 只缓存 10 秒**，并在工作文件夹变更、换段（`parts.js:545/720` 的 `renewMemory` 调用点）时清除。这样「同一个 cwd 后来补了 `.git`」不会被永久冻结为错误结论。
- **同步上下文怎么拿到 cwd**：`sectionFor`（`memory.js:838`）是同步函数，不能 `await rt.resolveAgent`。改为在 **Session 建立时与换段时**缓存 `sessionId → resolve(cwd)` 的结果（cwd 取自 `ctx.sessions.get(id)?.header?.cwd`，`dsh-session/lib/types/index.d.ts:447`，同步可读），键随 Session 生命周期；工作文件夹变更与换段按 `parts.js:545/720` 的现有调用点清除。提示词渲染直接读这份缓存。
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
| 按回合的自动 review | `memory.js:1417` | `ownScope(bot.id)` 硬编码 | 有项目且 `change.team !== true` → project |
| 记忆面板「问或更新」 | `memory.js:1259` | 同上硬编码 | 走同一判定点 |
| 面板单条删除 | `memory.js:1290` | 只认 team/own | 增加 project，且只能删该会话所属项目 |
| 删 Bot 归档 | `memory.js:786-803` | `rename` 旁路 | 只归档 own；项目记忆不随 Bot 删除 |

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

- **`WAITING` 只看本候选自己**：只查本候选所属的 work（`handoffs.js:71` 的 `waits(workId)`，参数是 work id 而非 Bot）与该候选**当前所属 Session** 上的待答卡片。`state.questions` 以 Session id 为键（`parts.js:806` 换段时会把卡片搬到新段），所以**不能只查候选入队时的旧 sessionId**：还要查该 Bot 当前在用的会话（`rt.chatOf(botId)` + `rt.groupSessionsOf(botId)`，与 `handoffs.js:142` 的取法一致）里是否有同一 `questionId` 的卡片。**不扫该 Bot 其他群聊里无关的问题。**
- **`WAITING` 的唤醒**：① 事件——子任务交回（`handoffs.js:39` `closeWork`）、问题被回答（`channel.js` 的 `answer-question`）、换段完成；② 重启——启动时扫 `task-plans/` 与 journal 中的 `task-candidate` 重建队列；③ 兜底——下一次该会话 idle。
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

- **`candidateId` 的确定生成规则**：`candidateId = sha256(sessionId + '\n' + callId)` 的前 32 位小写 hex。只含 `[0-9a-f]`，**天然是安全文件名**（不会再被拼进路径的其它部分），与 `memory.js:509` 的 `safeId` 同理但更严。同一 turn 内重试、进程重启后重放日志，`callId` 不变 → 同一 `candidateId` → 同一份计划。
- 文件名：`task-plans/<candidateId>.json`，**写一次后不可变**：

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
  "done": [] }
```

- **不可变**：`items` 写定后不再改；恢复只读，**绝不重新调用模型生成新计划**。`done` 是唯一可追加的字段。
- **写盘方式**：计划写入与 `done` 更新都用 **temp + rename**（复用 `memory.js:115-142` `writeTextTo` 的手法），不原地改写。**`done` 只能在对应条目的完整写入成功之后追加**，不能提前——否则崩溃后会把没写的条目当成写完。
- **逐项恢复，核对三件事**：
  1. `done` 是否已含该 `entryId`；
  2. 目标文件的 committed view 里是否已有**该 `entryId` 对应的最终格式整行**（计划里的 `line`，含元数据）。**仅正文相同不够**：同文不同元数据是另一条条目（`memory.js:764-766` 的注释就是这个意思），也不能证明链接已写齐；
  3. `MEMORY.md` 的 `## Index` 里是否有该 topic 的 `[[topic]]` 链接行。**缺则补**（`memory.js:195` `addLink`）。
- **任何一项不满足就修复该项**：缺行 → 写行；缺链接 → 补链接；行在但元数据不符 → 视为未完成，重做该项（先按现有 `replaceEntry` 语义处理，不静默叠加第二条）。
- **无变更的重复项也标 `done`**（`addNow` 返回 `changed:false` 时照样完成该计划项，`memory.js:646-647`），否则永远重试。
- **计划损坏**：`task-plans/*.json` 解析失败 → **原文件改名隔离**（`task-plans/corrupt/<candidateId>.<ts>.json`），journal 记 `op:'task-plan-corrupt'` 并在记忆面板/诊断里报告「需要人工处理」，**不删除、不自动永久 skip、不重做**。
- **人为冲突**：恢复时发现目标条目被手改成与计划不符（文本或元数据对不上），**停止该项**并记 `op:'task-plan-conflict'`，报告等待人工决定；**不自动覆盖用户的修改**。
- **强杀恢复边界**：允许在「文件写成功、`done` 未落盘」之间被杀（恢复靠上面第 2、3 项核对 → 判已完成或补齐 → 补记 `done`）。**不承诺断电场景下 `task-plans/*.json` 自身不损坏**——损坏按上一段处理。
- 提交粒度与恢复判定解耦：即使一次 `commit` 提交多条，恢复仍逐条按 `entryId` 判。

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
  hash TEXT,       -- 已提交内容的 sha256，一致性判定用
  PRIMARY KEY (scope, file)
);
```

### 5. 索引一致性（R3）

**改为「每次检索前做一次已提交内容比对」，取消两套派生状态文件。**

1. `recall` 开始时，对**本次允许的 scope** 逐个读文件（经 `memory-files.js:132` 导出的 `read`/`list`，它们覆盖 `pending`、排除回滚），算 `sha256`。
2. **比较完整文件集合**，不只是「已有的文件有没有变」：
   - 索引里有、磁盘上没有 → 在同一事务里**删掉该文件的全部旧行**；
   - 磁盘上有、索引里没有 → 全量插入；
   - 两边都有但 hash 不同 → 删旧行、插新行。
3. 第 1–2 步的所有写入在**同一个 SQLite 事务**内完成：要么整批生效，要么整批回滚，下一次重来。
4. **一致性边界**：快照采集与查询都在**既有写队列**的边界上取一致视图——`memory.js` 的写入全部经 `queued()` 串行（`memory.js:551-556`，`addNow` 在 `:638`、`replaceEntry:693`、`removeEntry:711`、`moveEntry:741`、`archiveBotMemory:792` 都在队列里）。刷新前先 `await` 队列尾部（即 `writing`）落定，再采集。这样**不会采到 `moveEntry` 的两步中间态**（先写 topic、再写 `MEMORY.md`，`memory.js:767` 与 `:771`）。
5. **索引更新失败**（打不开、写不进、事务失败）→ 直接用第 1 步已经读到内存的那份内容做子串扫描并返回（即现有 `memory.js:1092-1105` 的逻辑），**不再读第二次盘**。下次再试。
6. 启动时同理：索引缺失或版本不符 → 全量建一次；失败则全程走扫描。

**为什么这样能覆盖所有旁路**

这个方案**不需要任何写入钩子**，因此天然覆盖：

- `memory.js:771` 的 `moveEntry` 直接 `writeText(main.path, next)`，不经 `commit`；
- `memory.js:800` 的 `archiveBotMemory` 走 `rename`；
- 用户手工改写，包括**同大小、同 mtime 的改写**（比 mtime+size 可靠，因为比的是内容）。

**这不构成断电原子性保证**：普通 `fs` 写入（`writeText` 的 temp+rename，`memory.js:115-142`）只保证「不会留下半个目标文件」，不保证跨文件、跨 `journal` 的断电一致性。索引侧靠「下次比对内容」自我纠正；记忆侧靠既有 journal 与 `task-plans` 的恢复规则。

**代价，明确写出来**

每次 `recall` 都要读一遍该会话可见的全部 Markdown（每 scope 上限 40 个主题，`memory.js:37/652`）。这是 O(可见 Markdown) 的读放大，**本设计不声称 I/O 加速，也不把索引当性能优化**：索引在这里的作用是**提供 BM25 排序与跨 scope 检索**，不是省磁盘读。隔离与正确性优先于 I/O。

**排序与过滤**

- 权限过滤在 SQL 层：`scope IN (<本次白名单>)` 先过滤，再 `MATCH`，再 `LIMIT`。**顺序不能倒**——先 LIMIT 再过滤会把别的项目的命中挤掉，返回不足量。
- 排序两条：`rank`（BM25），同分按 `own > project > team`，再按 `added` 新到旧。

### 6. 检索语义（R7）

以下行为**必须与现有 `recall` 等价**，不能因引入索引而退化：

| 行为 | 要求 |
|---|---|
| 空查询 | 仍返回「存了什么」的目录式列举（数量、大小、主题列表），不报错、不返回空 |
| `topic` 参数 | 仍整份读一个主题，不受索引影响 |
| 全词优先 | 先找含全部词的条目；没有才退化为「含最多词」 |
| 短长混合查询 | ≥3 字走 FTS `MATCH`，1–2 字走 `LIKE`（`chat-index.js:23-42` 的既有手法）。已实测：trigram 下两字中文词命中为 0，`LIKE` 回退是必需项 |
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

`memory.js` 只做接线：`readScopes`、`recall` 的索引优先与回退、`complete_task` 注册、`writeScopeOf`。**不为了少几个文件把独立职责塞进已经 1714 行的 memory.js。**

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

1. **P1 项目隔离**：`project-scope.js` + project 存储 + `recall`/`remember` 的 scope + 提示词 + `writeScopeOf` 收敛。此时仍用现有子串检索，可独立验收。
2. **P2 全文索引**：`memory-index.js` + 内容比对刷新 + 重建端点 + 运行时探测。
3. **P3 任务复盘**：`complete_task` + `task-review.js` + 证据核验 + 计划持久化与恢复。
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

无法在本阶段验证的：桌面 Electron 端 sqlite（只影响平台声明）、崩溃注入点（需实现留钩子）。均为实现期验收项。

## 成本与风险

- 运行成本：索引为本地文件，查询无网络；每次 `recall` 读一遍可见 Markdown（接受）；复盘每条候选一次模型调用；无 embedding 成本。
- 风险：
  - 项目 id 随路径变化（搬动即新项目）——已定规则，靠提示不自动合并。
  - 词面检索不覆盖同义改写——已知限制。
  - 读放大随 scope 数与主题数增长——接受，换取一致性。
  - 历史 own/team 污染无法自动清理——人工整理。

## 已知限制

- 纯词面检索无法保证「换说法也能找到」。
- `verified` 只表示「有可复核引用且引用支持该主张」，不是客观真理。
- 每次 `recall` 读可见 Markdown：这是设计选择，不是待优化项。
- 项目搬动会产生新 hash，旧记忆需用户确认复用。
- 历史 own/team 中的项目内容不会被自动隔离。
- 记忆范围隔离是插件 API 层的，不是文件系统沙箱。

## 评审状态（R1–R7）

**设计结论：R1/R2/R5/R6/R7 已通过复审；R3/R4 待插件工程师交回。**
**代码：尚未实现；运行测试：待实施。**

| # | 评审问题 | 本稿处置 | 复审方 | 状态 |
|---|---|---|---|---|
| R1 | `cwd==teamFolder` 直接 `none`；Git 与标记物优先级；缓存冻结；Windows 大小写 | §1：先解析 Git/标记物，teamFolder 不再短路；Git 优先；`none/unresolved` 10s 过期；**不折叠大小写**，用 realpath 实际值 | 架构师 | **通过**（附 3 注记） |
| R1-a | 标记物向上搜索无界，上层散落的 `package.json` 会误判 | §1 加界：遇 teamFolder 或盘根即停，最多 3 层；`.git` 不受此限 | 架构师 | 已收（本轮） |
| R1-b | 子模块有 `commondir` 时归属未写明 | §1 明示：有 `commondir` 则归父仓库，子模块与父仓库同 id | 架构师 | 已收（本轮） |
| R1-c | 同步 `sectionFor` 拿不到 cwd（`resolveAgent` 是异步） | §1：Session 建立/换段时缓存 `sessionId → resolve(cwd)`，渲染读缓存 | 架构师 | 已收（本轮），仍需实现期验证 |
| R2 | 快照只校验 `teamRule`；面板摘要按 bot 键 | §7：快照首行带版本+排序 scope 集合；摘要键加 scopeSetHash；异步回包比对后落地 | 架构师 | **通过**（附注记） |
| R2-a | scope 标识不能替代原有 `teamRule`/角色校验 | §7 明写：两者任一不符都重建；旧无 v2 头快照视为过期 | 架构师 | 已收（本轮） |
| R3 | `moveEntry:771` 与 `rename` 旁路；两套派生状态 | §5：每次 `recall` 做已提交内容 hash 比对，hash 存 `files` 表，同事务刷新；删除 `index-dirty.json`/`index-hashes.json` | 插件工程师 | **核验中** |
| R3-a | 需比较完整文件集合；删除/归档文件要同事务删旧行 | §5 第 2 步写明三种情形（多、缺、变），同一事务 | 插件工程师 | 已收（本轮） |
| R3-b | 刷新可能采到 `moveEntry` 两步中间态 | §5 第 4 步：刷新前 `await` 既有写队列（`memory.js:551-556`）尾部 | 插件工程师 | 已收（本轮） |
| R4 | `entryId` 稳定性依赖计划持久化；journal 不够 | §3：不可变 `task-plans/<candidateId>.json`；恢复只读计划、不再调模型 | 插件工程师 | **核验中** |
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
- 2026-10-22（修订 6）：收架构师 R1/R2 三条注记（标记物搜索加界、子模块归父仓库、同步 cwd 缓存）；收本轮补充检查点：R3 比较完整文件集合 + 队列边界一致视图 + 不断电原子承诺、R4 补回 candidateId 规则与 temp+rename/done 顺序/三项恢复核对/损坏隔离/冲突停止、R5 file 真实路径校验 + 换段后待答卡片 + unverified 不入库 + 失败根因不连带、R2 保留 teamRule 校验。新增 13 条验收用例（40–52）。**评审状态：R1/R2 已通过，R3–R7 待插件工程师与测试工程师交回。**
- 2026-10-22（修订 7，本稿）：收测试工程师 R5/R6/R7 复审。把「原文支持该主张」落成两道闸（evidence 逐字子串为机械闸、模型 yes/no 为可复核闸）；project 校验改为四种转移，`unresolved→ok` 重绑定不丢候选；补用例 53–60（evidence 伪造、闸二 no/yes、project 四种转移、`projectMemory:false`、扫描失败显式报错）；用例 17 明确「非空或显式报错，二者其一」。R1/R2/R5/R6/R7 通过，R3/R4 待交回。
