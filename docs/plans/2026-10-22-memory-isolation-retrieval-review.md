# 记忆：项目隔离、本地全文检索增强、任务复盘

- 日期：2026-10-22
- 相关：本设计稿（设计阶段，未实现）；参照 `docs/plans/2026-10-09-context-and-memory.md`、`2026-10-16-bot-handoffs.md`
- 代码基线：`dev` @ `ba9757b`（含 PR #48/#49/#50 的记忆一致性修复）
- 状态：**设计评审中，未通过。** 本文是修订稿（R1–R7），待架构师、插件工程师、测试工程师本轮复审；代码未实现、运行测试未实施、未合并、未部署。

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
4. 都没有：
   - **cwd 等于团队工作区（`folders.js:23` `teamFolder()`）→ `none`**：显式认定为「分组目录」，不是一个项目。`D:\Dev\dsh-plugins` 就是这种：它按 `AGENTS.md` 不建总仓库。
   - **cwd 不是团队工作区 → 以 cwd 自身为根**（`kind: 'self'`），不向上吞并整个盘。
5. `hash = sha256(realpathSync.native(root))` 前 16 位小写 hex。**scope key = `project:<hash>`，目录名 = 纯 `<hash>`**（Windows 目录名不允许冒号）。

**`cwd === teamFolder` 不再直接判 `none`。** 这是 R1 的核心修正：从单仓库启动 DSH 时，团队工作区往往就是那个仓库的根。必须先走第 2、3 步；只有「团队工作区且整条向上链都没有 `.git` 和标记物」才判 `none`。

**Windows 大小写：不折叠**

`realpathSync.native` 已经返回本机的实际大小写，那才是这个目录的真实名字。Windows 支持按目录启用区分大小写，两个只在大小写上不同的目录可以同时存在且是两个项目。因此：

- **不对 realpath 结果做 `toLowerCase()`**，直接用它作键。
- 同一目录的不同写法（`D:\DEV\x` 与 `d:\dev\x`）经 realpath 后收敛到同一个实际大小写，自然同 id——不需要折叠也行。
- realpath 失败（目录不存在、不可读）→ `unresolved`，不做「猜测式」兜底。

**缓存**

- `status: 'ok'` 按 cwd 字符串缓存，进程内长期有效。
- **`none` / `unresolved` 只缓存 10 秒**，并在工作文件夹变更、换段（`parts.js:545/720` 的 `renewMemory` 调用点）时清除。这样「同一个 cwd 后来补了 `.git`」不会被永久冻结为错误结论。
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
- **执行前重新校验**：Bot 仍存在、仍是该群成员、会话仍属于该 Bot、project 解析结果未变。任一变化 → 作废该候选（journal 记 `op:'task-candidate-dropped'` 带原因），不写入。

**证据只看日志，不看模型自报**

- `tool/result` 的结构化字段只有 `message.isError` 与可选 `error{name,code,reason}`（`dsh-session/lib/types/types.d.ts:374-390`、`dsh-tools/lib/types/index.d.ts:197`）。**`exitCode` 不在结构里**，只在模型可见文本中 → 模型自报退出码一律不采信。
- **`isError === false` 不等于任务成功**：读文件成功、跑测试拿到失败报告但工具包装未报错，都是 `isError === false`。
- 判定按**具体主张**逐条进行，不做整体 AND：

| 主张来源 | 成立条件 | 结论 |
|---|---|---|
| `user` | 用户消息锚点存在且原文确有此意 | `verified`（记录「用户说过」，不是对世界的断言） |
| `command` / `test` | 对应 `callId` 的 `tool/result` 存在、`isError` 为假、**输出原文含支持该主张的结果** | `verified` |
| `command` / `test`（失败教训） | `isError` 为真，或输出原文明确显示失败 | `failed`（写成失败教训，标注依据） |
| `file` | 路径在该会话工作目录内、存在且类型相符；涉及内容须引原文片段 | 有片段 `verified`，仅存在 `unverified` |
| `answer` | 只证明「Bot 这样回答过」 | `unverified` |
| 缺证据 | — | **保持候选，不写长期记忆** |

**锚点与文件引用的权限边界**

- 锚点只能在**授权同源日志**里解析：`part N #seq` 经 `rt.partsOf(botId, roomId)`（`parts.js:245-255`）映射到 sessionId，且该 session 必须是本候选所属 Bot 的、或其所在这条会话链上的。**不允许借锚点读别的 Bot 或别的项目的日志。**
- `file` 引用必须落在该会话的工作目录内（`folders.js:28` `sessionFolder`），越界即 `INVALID`。**不能任意读文件。**

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

- **`WAITING` 只看本候选自己**：只查本候选所属的 work（`handoffs.js:71` 的 `waits(workId)`，参数是 work id 而非 Bot）与该候选 `sessionId` 上的待答卡片（`state.questions` 以 Session id 为键，`parts.js:806` 换段时搬移）。**不扫该 Bot 的其他群聊或会话。**
- **`WAITING` 的唤醒**：① 事件——子任务交回（`handoffs.js:39` `closeWork`）、问题被回答（`channel.js` 的 `answer-question`）；② 重启——启动时扫 `task-plans/` 与 journal 中的 `task-candidate` 重建队列；③ 兜底——下一次该会话 idle。
- **`memoryReview: false` 同时关闭新复盘**（`memory.js:503` 的 `reviewOn` 是现成开关）。如需分开，再加 `taskReview`，默认取 `reviewOn` 的值。本稿默认跟随，不新增配置项。
- 语义无效复用 `REJECTIONS_MAX = 3`（`memory.js:52`）的量级。

**经验条目的必备结构**

每条写入的条目必须同时含三部分，缺一即不写：

1. **适用条件**：什么时候成立（项目、工具、环境、前提）。
2. **结论或教训**：做成了什么，或为什么失败、下次怎么做。
3. `source`：锚点或 `callId`，可复核。

外加元数据 `outcome`（`verified` / `failed` / `unverified`）与 `evidence`（原文摘录，截断）。`recall` 返回时显示 `outcome`。

**原回合 review 不得抢先写「成功经验」**

现有按回合 review（`memory.js:1493` `reviewSession`）的提示词必须加一条硬约束：**不得写入任何断言「任务成功」的条目**，除非证据是用户原话，或该会话存在已通过证据核验的 `complete_task` 候选。普通对话里的「我完成了」不算。

**持久化提取计划（R4）**

- 文件：`task-plans/<candidateId>.json`，**写一次后不可变**：

```json
{ "version": 1, "candidateId": "…", "botId": "…", "sessionId": "…",
  "roomId": null, "project": "project:<hash>|null", "createdAt": "…",
  "items": [
    { "entryId": "sha256(candidateId + ':' + index)[0:16]", "index": 0,
      "scope": "project:<hash>", "topic": "…", "text": "…",
      "outcome": "verified", "source": "part 2 #1234",
      "meta": { "kind": "howto", "added": "…" } }
  ],
  "done": [] }
```

- **不可变**：`items` 写定后不再改；恢复只读，**绝不重新调用模型生成新计划**。`done` 是唯一可追加的字段。
- **逐项恢复**：对每个 `entryId`，先看 `done` 是否含它；不含则查目标文件的 committed view 里是否已有该条正文（见下）——有则补记 `done`，无则写入后补记 `done`。**「正文已写、journal 未写」用文件内容判定，不靠 journal。**
- **无变更的重复项也标 `done`**（`addNow` 返回 `changed:false` 时照样完成该计划项，`memory.js:646-647`），否则永远重试。
- **强杀恢复边界**：允许在「文件写成功、`done` 未落盘」之间被杀。此时恢复会看到正文已在 → 判为已完成 → 不重复写。允许在「`done` 已落盘、journal 未落盘」之间被杀，`done` 是权威。**不承诺断电场景下 `task-plans/*.json` 自身不损坏**；损坏则整份计划作废并记 `op:'skip'`，不重做（宁可漏，不重复）。
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
2. 与 `files` 表里的 `hash` 比对：
   - 相同 → 该文件索引有效。
   - 不同或缺失 → 重扫该文件**全部行**，删旧行插新行。
3. 第 2 步的所有写入在**同一个 SQLite 事务**内完成：要么整批生效，要么整批回滚，下一次重来。
4. **索引更新失败**（打不开、写不进、事务失败）→ 直接用第 1 步已经读到内存的那份内容做子串扫描并返回（即现有 `memory.js:1092-1105` 的逻辑），**不再读第二次盘**。下次再试。
5. 启动时同理：索引缺失或版本不符 → 全量建一次；失败则全程走扫描。

**为什么这样能覆盖所有旁路**

这个方案**不需要任何写入钩子**，因此天然覆盖：

- `memory.js:771` 的 `moveEntry` 直接 `writeText(main.path, next)`，不经 `commit`；
- `memory.js:800` 的 `archiveBotMemory` 走 `rename`；
- 用户手工改写，包括**同大小、同 mtime 的改写**（比 mtime+size 可靠，因为比的是内容）。

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
- **普通记忆内容更新仍保持现有冻结策略**：同一 Session 内保存的新条目照旧不进本次提示词，靠 `recall` 查。只有 scope 集合变化或版本升级才重建。

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
| 17 | 索引不可用（模拟导入失败） | 回退扫 Markdown，结果非空；**不返回「没有记忆」** |
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

**设计结论：未通过，待本轮三方复审。**
**代码：尚未实现；运行测试：待实施。**

| # | 评审问题 | 本稿处置 | 复审方 |
|---|---|---|---|
| R1 | `cwd==teamFolder` 直接 `none`；Git 与标记物优先级；缓存冻结；Windows 大小写 | §1：先解析 Git/标记物，teamFolder 不再短路；Git 优先；`none/unresolved` 10s 过期；**不折叠大小写**，用 realpath 实际值 | 架构师 |
| R2 | 快照只校验 `teamRule`；面板摘要按 bot 键 | §7：快照首行带版本+排序 scope 集合；摘要键加 scopeSetHash；异步回包比对后落地 | 架构师 |
| R3 | `moveEntry:771` 与 `rename` 旁路；两套派生状态 | §5：改为每次 `recall` 做已提交内容 hash 比对，hash 存 `files` 表，同事务刷新；删除 `index-dirty.json`/`index-hashes.json`；接受 O(可见 Markdown) 读放大 | 插件工程师 |
| R4 | `entryId` 稳定性依赖计划持久化；journal 不够 | §3：不可变 `task-plans/<candidateId>.json`；恢复只读计划、不再调模型；用文件内容判定「正文已写、journal 未写」；无变更项也标 done；写明强杀边界 | 插件工程师 |
| R5 | 候选绑定与重校验；锚点/文件权限；全链路脱敏；WAITING 范围与唤醒；`memoryReview` 联动；经验结构；原 review 抢写 | §3 各段：入队绑定 + 执行前重校验；锚点限同源、file 限工作目录；计划/摘要/证据/notes/meta/journal 全部脱敏；WAITING 只看本候选；重建队列；跟随 `reviewOn`；三要素必备；reviewSystem 加硬约束 | 测试工程师 |
| R6 | 模型/接口不得传任意 hash；异步防串；边界声明 | §7：模型工具无 `project` 参数；面板只能从服务端列表选；服务器三查；异步带 scopeSet；明确「API 范围隔离 ≠ 沙箱」 | 测试工程师 |
| R7 | 查询语义不得退化 | §6：七条逐一列明，含 filter 先于 LIMIT、异常不伪装成空结果 | 测试工程师 |

**外部参考已更正**：固定 commit `6037f8e3b91d657f5eac80ef764b41ce511499dc` 的 `jiuwenswarm/common/coding_memory_paths.py:43–79` 有项目路径隔离；`jiuwenswarm/agents/harness/common/tools/task_tools.py:309–401` 的 `experience_learn` 实际写 `task-data.json`。此前「对方没有实现」的断言删除。**这不等于其任务结果已做证据验收**——本设计的证据核验规则仍是原创补齐。

**无代码或文本复制。** Chief 复核：`git grep` 与全树搜索 `MemoryIndexManager|chunks_vec|chunks_fts|build_fts_query|TodoToolkit|EMBEDDING_CACHE_TABLE|vector_to_blob|list_memory_files|is_memory_path` 均无命中。

## 变更

- 2026-10-22：初稿。
- 2026-10-22（修订 2）：修正存储根、目录名、单一规范化算法、第一方写入的 project 传递、多 claims 幂等、索引字段。
- 2026-10-22（修订 3）：JiuwenSwarm 引用降级。
- 2026-10-22（修订 4）：收回桌面探针授权阻塞，改运行时探测；面板显式项目上下文；幂等定死逐项恢复；补逐项关闭表。
- 2026-10-22（修订 5，本稿）：按 R1–R7 全面修订——项目身份重写（Git 优先、teamFolder 不短路、大小写不折叠、缓存过期）；快照与面板摘要加 scope 版本；索引改为内容比对并删除两套派生状态；提取计划持久化与强杀恢复边界；候选绑定/重校验/全链路脱敏/WAITING 收窄/review 抢写约束；面板与 API 权限边界；查询语义七条。删除「对方没有实现」的断言，改为固定 commit 引用。**本轮评审未通过，待三方复审。**
