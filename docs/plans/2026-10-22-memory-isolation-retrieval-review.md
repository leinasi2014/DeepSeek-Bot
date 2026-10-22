# 记忆：项目隔离、本地全文检索增强、任务复盘

- 日期：2026-10-22
- 相关：本设计稿（设计阶段，未实现）；参照 `docs/plans/2026-10-09-context-and-memory.md`、`2026-10-16-bot-handoffs.md`
- 代码基线：`dev` @ `ba9757b`（含 PR #48/#49/#50 的记忆一致性修复）
- 状态：设计评审中，未实现、未合并、未部署

## 为什么

现有记忆只有两级：Bot 自己的 `MEMORY.md` 与团队记忆。它们跨所有对话、所有项目共享。于是：

- 在项目 A 学到的约定（命令、目录布局、代码风格）会出现在项目 B 的会话里，反之亦然。
- `recall` 只做子串计分（`memory.js:1092-1098`），条目一多就难以命中。
- 任务做完后，经验只靠「记忆整理」顺手捡，缺少「这件事真的做完了」这一环，失败教训尤其容易丢。

本设计补三件事：项目记忆隔离、本地全文检索、任务结束后的经验复盘。三件事都寄生在现有机制上：同一套 Markdown + journal + 提交回滚、同一套 SQLite FTS5 手法、同一条 review 通道。

**明确不做向量**：不引入 embedding、向量库、向量检索、相关 API Key，也不留可选的接口预留。检索只做本地词面检索，不承诺语义理解。

## 已定的行为

### 1. 项目身份

**Git 仓库**

- 从会话工作目录向上找 `.git`。
- `.git` 是目录：该目录即仓库元数据目录。
- `.git` 是文件：读取首行 `gitdir: <path>`，相对路径相对于 `.git` 文件所在目录解析；再读 `<gitdir>/commondir`（内容通常为 `../..`，相对 `<gitdir>` 解析），得到 **common dir**。
- 项目 **hash** = `sha256(规范化后的 common dir)` 前 16 位（小写 hex）；`win32` 上规范化时先转小写。目录名用它。
- **scope key** = `project:<hash>`，只出现在 journal 与索引的 `scope` 列，不用于文件名（Windows 目录名不允许冒号）。

主仓库与它的所有 worktree 因此得到同一个 id。已实测：worktree 的 `.git` 文件为 `gitdir: D:/.../main/.git/worktrees/wt`，`<gitdir>/commondir` 为 `../..`，`git rev-parse --git-common-dir` 返回主仓库 `.git`。

**非 Git 目录**

- 从工作目录向上找**最近一层**含标记物的目录：`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml`、`*.csproj`。
- 都没有：以工作目录本身为根。
- 项目 id 算法同上（对根目录 realpath 取 hash）。

**Windows 大小写**

- 仅在 `process.platform === 'win32'` 时把 realpath 结果转小写再取 hash；不做文件系统大小写探测，不做路径前缀替换。其他平台原样。
- 适用范围写进注释与单测：两种大小写写法必须得到同一 id。

**单一规范化规则：只有一个函数，读数与写数都调它**

提示词 section 是同步的（`dsh-system-prompt/lib/types/index.d.ts:60`：`text: string | ((context) => string)`），所以项目身份必须能同步取到。做法是**把整条链路做成同步**，不给读写留两套算法：

```
resolve(cwd) -> { status: 'ok', id, root } | { status: 'none' } | { status: 'unresolved', reason }
```

1. 取 cwd：`ctx.sessions.get(sessionId)?.header?.cwd`（`dsh-session/lib/types/index.d.ts:447`；`session.header` 始终存在，同文件 `:116-119`）。
2. `realpathSync.native(cwd)`；`win32` 上再 `toLowerCase()`。**realpath 与大小写只在这里做一次**，之后不再出现第二种写法。
3. 向上找 `.git` 或标记物（全同步：`statSync`/`readFileSync`/`readdirSync`）。
4. 得到 `root` 后再 `realpathSync.native(root)`、`win32` 小写，取 `sha256` 前 16 位为 `id`。
5. 结果按 `cwd` 字符串缓存（进程内 Map，含 `status`），失效只在 cwd 变化时发生。

- 读数（提示词）与写数（`remember`、自动 review、面板）调的是**同一个函数**，不存在「读按 cwd hash、写按 commonDir 校正」的第二条路径。
- `none`：cwd 等于团队工作区目录（`folders.js:23` 的 `teamFolder()`），即没有专属工作文件夹的会话。这类会话没有项目范围。
- `unresolved`：cwd 缺失、不可读，或 `.git` 解析失败。**此时不把项目内容默认写进全局 own**：`remember` / `move` / `forget` 的隐式 project 目标一律拒绝并说明「这个会话的项目无法识别，请显式给出 scope 或检查工作文件夹」；`recall` 仍可读 own + team。提示词 section 遇到 `unresolved` 只渲染 own + team，不报错。

**`.git` 文件没有 commondir 时**（子模块、`git init --separate-git-dir` 等）：直接用 `gitdir` 指向的目录作为根，不再向上读 `commondir`。判定顺序固定为：`.git` 是目录 → 用它；`.git` 是文件 → 解析 `gitdir:` → **有 `commondir` 就用它，没有就用 `gitdir`**。

**搬动与重命名**

- `projects.json` 只记录 `project:<hash> → 明文路径 + 最后确认时间`，不参与判定。
- 路径变了就是新 id，新项目记忆从空开始。
- 同一团队已存在 **basename 相同**的旧路径时，提示一次「复用旧记忆 / 新建」，由用户选择。
- **不自动合并**。basename 相同只作提示线索，不构成同一项目的证明。

### 2. 记忆的可见性与写入范围

| 记忆 | 读 | 写 |
|---|---|---|
| 自己的 `MEMORY.md` + 主题 | 本人 | 本人；Main Bot 在用户要求时可写 |
| 团队记忆 | 所有 Bot | Main Bot、群管理员 |
| 项目记忆（新） | **只有工作在该项目内的会话** | **只有工作在该项目内的会话** |

- Main Bot 的跨 Bot 读写权限**不延伸到项目记忆**：项目记忆的边界是项目，不是 Bot。这样「一个插件的约定串进另一个插件」在读写两侧都不可能发生。
- 默认检索范围：有项目时为 `own + project + team`；无项目时仍为 `own + team`。
- 有项目时，`remember` 的**默认写入目标改为 project**；`own` 留给跨项目的个人偏好，`team` 留给团队通用。提示词规则同步修改。

**所有第一方写入都必须显式携带 project，不能只靠默认参数**

改 `remember` 的默认值和提示词**不足以**隔离：现有还有两条自动写 own / team 的路径，实测行号如下。

| 写入路径 | 现有代码 | 现状 | 本项目要求 |
|---|---|---|---|
| `remember` / `forget` / `move` | `memory.js:949/985/1008` | 工具参数决定 scope | 有项目时缺省=project；显式 `own`/`team` 仍可用 |
| 按回合的自动 review | `memory.js:1417`：`const scope = op === 'add' ? (change.team === true && teamWrites ? TEAM : ownScope(bot.id)) : …` | **`ownScope(bot.id)` 是从这里硬编码的**，不看项目 | 该 Session 有项目且 `change.team !== true` 时写 project；`change.team === true` 仍是 team |
| 记忆面板「问或更新」 | `memory.js:1259`：同一个硬编码 `ownScope(bot.id)` | 同上 | 面板按**当前 Bot 打开的那个会话**解析项目；无明确会话时不写 project，只写 own/team |
| 面板单条删除 | `memory.js:1290`：`body.scope === 'team' ? TEAM : ownScope(bot.id)` | 只认两值 | 增加 `'project'`，且只能删该会话所属项目 |
| 删 Bot 归档 | `memory.js:786-803`，`rename` 走 `projects/` 下需一并处理 | 只归档 own | 归档 own；项目记忆**不随 Bot 删除**，属项目 |

约束落点：把 scope 决定收成**一个函数** `writeScopeOf(sessionId, requested)`，上述四条路径全部调用它，不再各自拼 `ownScope(bot.id)`。这样「所有第一方写入」只有一个判定点，可被单测穷举。

- Main Bot 的跨 Bot 读写权限**不延伸到项目记忆**：项目记忆的边界是项目，不是 Bot。这样「一个插件的约定串进另一个插件」在读写两侧都不可能发生。
- **「不串项目」的保证只覆盖新写入**：历史 own/team 中的项目内容不会被自动隔离，见「已知限制」。

### 3. 任务完成与经验复盘

**四种「结束」必须分开**

| 概念 | 信号 | 是否触发复盘 |
|---|---|---|
| 回合结束 | `agent/status` = `idle` | 否，只作唤醒时机 |
| 换段 / 压缩 | 上下文管家判定；**失败或答不出也换段**，上下文溢出直接换段 | 否，绝不触发 |
| 阶段完成 | Bot 自己的叙述、进度说明 | 否 |
| 任务验收 | `complete_task` 候选 + 证据核验 | 是，且仅当前三步都不是唯一依据 |

管家（`steward.js`）的 `switch` 是**上下文管理决策**，不是验收结论：`docs/plans/2026-10-09-context-and-memory.md:43`（溢出直接换段）、`:55`（管家失败换段）都说明它与任务成败无关。因此复盘**不订阅** `switch`。

**`complete_task` 只是候选**

- 参数：`result`（一句话结果）、`claims[]`（每条含 `kind`、`ref`、`statement`）、可选 `notes`。
- `kind`：`answer`（纯问答、设计结论）、`file`、`command`、`test`、`user`（用户原话）。
- 调用即写 journal `op:'task-candidate'`，**当轮不写任何记忆**。
- 候选 id = `sessionId + callId`（`exec.callId` 在 `dsh-tools/lib/types/index.d.ts:217` 为只读必填）。它只覆盖**同一次工具调用的重放**：同一 turn 内的重试、进程重启后重放同一份日志，id 不变。**换段后 Bot 重新调用 `complete_task` 会拿到新的 `callId`，id 就变了**，此时靠内容去重（见下）。

**证据只看日志，不看模型自报**

- `tool/result` 的结构化字段是 `message.isError` 与可选 `error{name,code,reason}`（`dsh-session/lib/types/types.d.ts:374-390`、`dsh-tools/lib/types/index.d.ts:197`）。**`exitCode` 不在结构里**，只可能出现在模型可见的文本里，因此模型自报的退出码一律不采信。
- **`isError === false` 只说明这次工具调用没有报告工具级错误，不等于任务成功**：读文件成功、跑测试得到失败报告但工具包装未报错，都是 `isError === false`。
- 判定按**具体主张**逐条进行，不把多个条件做 AND 当成整体通过：

| 主张来源 | 成立条件 | 结论 |
|---|---|---|
| `user`（用户的决定、约束、偏好） | 用户消息锚点存在，且原文确有此意 | `verified`（记录的是用户说过的话，不是对世界的断言） |
| `command` / `test` | 对应 `callId` 的 `tool/result` 存在；`isError` 为假；**输出原文中含支持该具体主张的结果**（如测试报告的成功/失败行、命令的实际输出） | `verified` |
| `command` / `test`（失败教训） | `isError` 为真，或输出原文明确显示失败 | `failed`（写成失败教训，标注依据） |
| `file` | 路径存在且类型相符；若主张涉及文件内容，需引原文片段 | 有片段 `verified`，仅存在 `unverified` |
| `answer`（Bot 自己的结论） | 只说明「Bot 这样回答过」 | `unverified` |
| 缺少对应证据 | — | 保持候选，**不写成长久记忆** |

- 每条写入的条目带 `outcome` 与 `evidence`（**原文摘录**，长度截断）与 `source`（锚点或 `callId`）。`recall` 返回时显示 `outcome`。
- `verified` 的含义严格限定为「有可复核的引用，且引用内容支持该主张」，不等于客观真理。引用随条目保存，人和后续会话都能复核。

**状态机与三类失败**

```
(无) --complete_task--> PENDING
PENDING --条件未满足（子任务未回 / 问题未答）--> WAITING（不计数、不丢弃）
PENDING --暂时 I/O 失败--> TRANSIENT（独立计数、退避重试；到上限只告警）
PENDING --语义无效（答复不合规、证据全不成立）--> 计数，3 次后 SKIPPED（journal 带全文，可人工补记）
PENDING --证据成立--> WRITTEN
```

- `WAITING` 不累计、不丢弃；由子任务交回（`handoffs.js` 的 `closeWork`）、问题被回答、或下一次 idle 唤醒。
- 语义无效复用现有量级：`memory.js:52` 的 `REJECTIONS_MAX = 3`。
- 不新建任务引擎：没有任务列表、状态面板、跨会话推进。

**幂等：按「候选 + 条目」定位，不按「候选」整条跳过**

一条候选可以有多条 claims，每条落成一个条目。若只用 candidate id 判「已入库」，写完第一条就崩溃时，恢复会因「这个 candidate 已有记录」而跳过剩下的条目——**必须按条目定位**。

- 条目稳定标识 = `entryId = sha256(candidateId + claimIndex)` 前 16 位，写进 journal 的 `op:'task-review'` 记录。
- 恢复时逐条比对：**该 `entryId` 已有写入记录** → 跳过该条；没有 → 写入。因此崩溃在任何一条之后都能继续，不会重复也不会漏。
- **选定：逐项稳定 ID 恢复**（`entryId`），不用「批量提交」当恢复机制。理由：`commit` 的原子性只是**进程内异常回滚**（备份 → 写文件 → 追加 journal → 失败则 rename 回滚），它不保证断电或 kill 后的原子性；把 catch-error 回滚误当断电原子性会直接导致条目丢失或重复。逐条恢复的协议是：先按 `entryId` 查 journal，未写过的才写，写完即记 `op:'task-review'` 带 `entryId`。崩溃点在哪都只影响「还没写的那几条」。
- **二次提交去重边界**：`sessionId + callId` 只能覆盖**同一次工具调用的重放**（同一 turn 内重试、进程重启后重放日志）。换段后 Bot 重新调用 `complete_task` 会得到新的 `callId`，候选 id 不同——这段去重靠内容：现有 `matchEntries` 整句比对在 `memory.js:646-647` 返回 `changed:false`，不会写出第二条同文条目。**但同义不同措辞的重复提交不会被发现**，这是明确边界，不承诺。为避免这类重复，提醒提示词：同一任务只调用一次 `complete_task`。

### 4. 存储与数据模型

**根目录**：`ds-bot/index.js:52` 是 `const home = config.home ?? join(dshHome, 'bot')`，`memory.js:504` 是 `const root = join(home, 'memory')`。所以记忆根是 **`<botHome>/memory`**，默认 **`<DSH_HOME>/bot/memory`**（`config.home` 可覆盖 `bot` 这一层）。

**scope key 与目录名分开**

`proj:<hash>` 只作 **scope key**（写进 journal、索引 `scope` 列）。目录名用**纯 hash**，因为 Windows 目录名不允许冒号：

```
<botHome>/memory/
  bots/<botId>/MEMORY.md + <topic>.md        现有，不动
  team/MEMORY.md + <topic>.md                现有，不动
  projects/<hash>/MEMORY.md + <topic>.md     新增，结构同构；<hash> 为 16 位 hex，无冒号
  journal.jsonl                              现有；新增 op: task-candidate / task-review
  snapshots/                                 现有，按 Session 冻结
  reviewed.json / rejections.json             现有
  projects.json                              新增：project:<hash> → 明文路径
  index.sqlite                               新增：可重建的派生索引
  index-dirty.json                           新增：待刷新范围（持久化）
  index-hashes.json                          新增：文件内容哈希（见第 5 节）
```

`dirOf(scope)` 对 project 分支拼 `projects/<hash>`，`scopeKey(scope)` 返回 `project:<hash>`。两者由同一个 `hash` 派生，不存在第二种写法。

**索引表（含排序所需字段）**

```sql
CREATE VIRTUAL TABLE entries USING fts5(
  text,                       -- 条目正文，检索对象
  scope UNINDEXED,            -- scope key：bot:<id> / team / project:<hash>
  file UNINDEXED,             -- 相对 root 的文件路径
  line UNINDEXED,             -- 在该文件中的行号，用于回读校验
  added UNINDEXED,            -- 条目元数据里的 added 日期，排序用
  tokenize = 'trigram'
);
CREATE TABLE files (
  scope TEXT, file TEXT,
  mtime REAL, size INTEGER,   -- 辅助信号，不作唯一依据
  PRIMARY KEY (scope, file)
);
```

- `added` 进 `entries` 是因为排序规则里有「同分按 added 新到旧」；没有这一列，排序要在内存里补取，等于每查一次多读一遍文件。
- `trigram` 分词：中文三字以上无需切词；两字以下回退 `LIKE`（照 `chat-index.js:23-42` 的手法）。
- 权限过滤在 SQL 层：`scope IN (<本次白名单>)` 先过滤再 `MATCH`。白名单由调用方传入，索引内容不参与权限判断。
- 排序只有两条：`rank`（BM25），同分按 `own > project > team`，再按 `added` 新到旧。不预置短语加权，等测试数据说话。

### 5. 索引一致性

- **只读已提交视图**：用 `memory-files.js:132` 导出的 `read`/`list`，它们覆盖 `pending`（未提交写入）并排除回滚。索引构建与刷新一律经过它们，不直接 `fs.readFile`。
- **写入触发失效**：`commit()` 成功返回时回调 `onCommitted(paths)`，把路径并入 `dirty`。现有三个写入口（`memory.js:670/704/720`）全部经过 `commit`，面板写入同样经过它。
- **旁路也要标脏**：`archiveBotMemory`（`memory.js:800`）走 `rename`，必须单独标脏并删除该 scope 的索引行。
- **刷新时机**：每次 `recall` 前先 flush `dirty`：重扫这些文件的**全部行**，不是只补命中项——否则「新增条目」和「改写后命中查询词」都会漏。
- **删除兜底**：查询命中后对命中文件做存在性检查，文件已不存在则丢弃该批行并标脏。
- **启动时**：索引缺失或版本不符则全量重建；随后对全部记忆文件各算一次内容哈希，与 `index-hashes.json` 比对，覆盖「运行期外被改写」。哈希存 `index-hashes.json`（`{ "scope|file": "sha256" }`），和索引一起可删可重建。这里没有性能断言：文件数上限是每 scope 40 个主题（`memory.js:37` `topics: 40`，`memory.js:652` 按 scope 判），加上 `MEMORY.md`，成本随 scope 数线性增长，实现时按实际规模测。
- **运行期手工改写**：`mtime + size` 无法可靠发现同大小同时间戳的改写。**明确提供显式重建**（记忆面板的「重建索引」或对应端点），并在已知限制中写明。这是本设计的已知缺口，不用轮询伪装成已解决。
- **索引更新失败**：该 scope 标脏并**整体回退到扫 Markdown**（现有 `recall` 逻辑，`memory.js:1092-1105`），下次再试。绝不返回半新半旧的结果。

### 6. 工具与接口的最小变化

| 变化 | 内容 |
|---|---|
| `complete_task`（新工具） | 只记录候选与主张，不写记忆 |
| `recall` | 默认范围加 project；输出加 `project` 标签与 `outcome`；新增可选 `scope: "project"` |
| `remember` / `forget` / `move` | 签名不变；`scope` 接受 `"project"`；有项目时默认目标为 project |
| 记忆面板 | 显示条目 `outcome` 与证据；新增「重建索引」动作；**项目记忆以显式项目上下文操作**（见下） |
| 配置 | 只加一项 `projectMemory`（默认开）。理由是回退开关：出错时能整体关掉项目范围而不影响现有记忆 |

**面板的 project 操作必须显式带项目上下文，并由服务器校验**

面板以「某个 Bot」为对象，而项目身份属于会话；靠「猜当前会话」会在多窗口、换段、会话已关闭时错判。因此定为：

- 面板请求携带 `project`（`project:<hash>`）作为显式参数；不带就是 own / team，不隐式推断。
- 服务器校验三件事后落库：① `project` 格式合法且 `projects/` 下确实存在该目录；② 请求者携带的 Bot **确有或曾有**落在该项目内的会话（用 `projects.json` 记录的路径与 `sessionFolder` 历史比对）；③ 该 scope 未被 `projectMemory: false` 关闭。任一不满足即拒绝并说明原因，不静默改写到 own。
- 这条同时消除了此前「面板按当前会话解析项目」的实现期不确定项。

不新增服务、不新增常驻进程、不改 DSH。

### 7. 模块划分

| 文件 | 职责 | 为什么独立 |
|---|---|---|
| `src/host/project-scope.js` | 同步/异步解析项目身份、`projects.json` | 有独立失败面（`.git` 文件格式、commondir、盘符大小写、realpath 竞态），三方共用，且是纯函数，最好单测 |
| `src/host/memory-index.js` | 索引生命周期、dirty 刷新、查询、重建 | 生命周期（惰性打开、重建、降级）与 journal/回滚完全不同；`chat-index.js` 已证明这个模式适合独立成文件 |
| `src/host/task-review.js` | 候选队列、证据核验、提取调用、幂等写入 | 异步、模型驱动、可失败可重试，与同步记忆工具解耦 |

`memory.js` 只做接线：`readScopes`、`recall` 的索引优先与回退、注册 `complete_task`、提交后标脏。**不为了少几个文件把独立职责塞进已经 1714 行的 memory.js。**

## 默认行为与故障降级

| 层 | 默认 | 失败时 |
|---|---|---|
| 项目识别 | 自动 | 解析失败按「无项目」，其余功能不受影响 |
| 项目记忆 | 开 | `projectMemory: false` 整体关闭，回到 own + team |
| 全文索引 | 开 | 无 `node:sqlite` / 损坏 → 删文件重建一次 → 仍失败 → 扫 Markdown |
| 复盘 | 开 | 提取失败按三态处理，不阻塞对话、不影响记忆工具 |

## 兼容与迁移

- 现有 own / team 记忆与 journal 一字不动，不自动迁移。
- 项目记忆从空开始；首次检索时索引为空，增量构建。
- 提示词新增一条：有项目时，项目相关的约定写 project，不要写进 own / team。
- **已知历史污染**：过去写进 own / team 的项目约定已经存在，无法自动区分。设计不自动迁移，提供一次性人工整理说明（按 `source` 与主题判断后 `move` / `forget`）。
- 回退：删 `index.sqlite` 即可重建；`projectMemory: false` 立刻回到旧行为。

## 分阶段实施顺序

**运行时可探测，不是人为授权阻塞。** 索引能力按运行时探测：启动时 `await import('node:sqlite')` 并试建一张 `fts5 ... trigram` 表，成功则启用索引，失败则**永久降级到扫 Markdown**（现有 `recall` 逻辑），本进程内不再重试。不需要用户批准，也不需要在用户的桌面环境加载探针。

已实测（本轮，DSH Web 运行时）：

- DSH Web 进程为 `node C:\Program Files\nodejs\node.exe ... dsh/lib/bin.js web`，Node **24.20.0**。
- 同一运行时下 `require('node:sqlite')` 可用，SQLite **3.53.4**，`fts5 ... tokenize='trigram'` 建表与 `MATCH` 查询均正常。
- 同一探针证实：两字中文词（`"记忆"`）在 trigram 下**命中 0**，四字词命中 1。**这独立验证了「两字以下回退 LIKE」不是冗余设计，而是必需项**（与 `chat-index.js:23-42` 的既有手法一致）。

未验证的只有 **DSH 桌面 Electron 端**，它影响的是「已验证平台」列表，不影响架构成立：桌面端若不可用，自动走 Markdown 降级。

1. **P1 项目隔离**：`project-scope.js` + project 存储 + `recall`/`remember` 的 scope + 提示词。此时仍用现有子串检索，功能可独立验收。
2. **P2 全文索引**：`memory-index.js` + dirty/已提交视图 + 显式重建 + 面板动作 + 启动时能力探测。
3. **P3 任务复盘**：`complete_task` + `task-review.js` + 证据核验 + 幂等。
4. **P4 验收与文档**：补齐用例、`docs/plans` 定稿、README 行为说明（英文与中文同步）。

每阶段单独 PR，指向 `dev`，不改 `CHANGELOG.md`。

## 明确暂缓

- 向量、embedding、向量库、外部检索框架：**不做，且不留接口**。
- 自动候选复核（把「阶段停顿」猜成完成）：等显式入口跑出数据再议。
- 记忆 TTL、自动清理、跨机器同步、自动合并搬动后的项目、Dreaming 式离线整理。
- 任务列表 / 状态面板 / 跨会话任务推进：不建任务管理平台。

## 验收用例

| # | 用例 | 断言 |
|---|---|---|
| 1 | 项目 A 写入，项目 B 会话 `recall` 全量列举 | 零 A 条目；SQL 白名单外不可见 |
| 2 | 同仓库两个 worktree 各写一条 | 落在同一 `projects/<hash>`；相互可见 |
| 3 | 非 Git 目录两层子目录 | 最近标记物那层为根，不与父项目合并 |
| 4 | win32 两种大小写路径 | 同一 id |
| 5 | 中文两字词、三字以上词、英文单词 | 均召回；一字词走 `LIKE` 不报错 |
| 6 | 删除条目后下一次 `recall` | 旧文本不再命中 |
| 7 | 改写条目使其含查询词 / 新增含查询词条目 | 下一次 `recall` 立即命中（证明不是只校验命中项） |
| 8 | 删 `index.sqlite` 后 `recall` | 自动重建，结果与删除前一致 |
| 9 | 无 `node:sqlite`（模拟导入失败） | 回退扫 Markdown，结果非空 |
| 10 | 管家异常换段（失败 / 溢出两条路径） | 复盘候选为 0，无写入 |
| 11 | 模型谎报完成：`complete_task` 声言成功，日志 `tool/result.isError === true` | 记为 `failed`；模型自报 exitCode 不参与判定 |
| 12 | 工具成功但输出显示测试失败（`isError === false`） | **不判 verified**；无其他证据则保持候选 |
| 13 | 纯问答任务，用户消息确认决定 | 以用户锚点为证据记 `verified`，不强制命令 |
| 14 | 候选跨段引用 `part N #seq` | 经 `partsOf` 映射后可解析；不存在则 `INVALID` |
| 15 | 一条候选含 3 条 claims，写完第 1 条后崩溃，重启恢复 | 第 2、3 条仍被写入；每条恰好一次 |
| 16 | 同一 `callId` 重放（进程重启后重放日志） | 不重复写入 |
| 17 | 换段后 Bot 再次调用 `complete_task`，内容与上次逐字相同 | 靠 `matchEntries` 整句比对不写第二条；**措辞不同则不保证**，用例只断言逐字相同的情形 |
| 18 | 子任务未回 / 问题待答 | `WAITING`，不计数、不丢弃；子任务交回后继续 |
| 19 | 三次语义无效 | `SKIPPED`，journal 带全文，可人工补记 |
| 20 | 密钥形态文本 | 永不入库（复用 `looksSecret`） |
| 21 | 自动 review（`memory.js:1417` 路径）在有项目的会话里运行 | 写入落在 project，不落 own |
| 22 | 面板「问或更新」（`memory.js:1259` 路径）在有项目的会话里运行 | 写入落在 project；无明确会话时不写 project |
| 23 | 删 Bot 归档（`memory.js:800` 的 `rename` 旁路） | project 记忆不受影响；索引对应 scope 被标脏 |
| 24 | 项目会话里 `.git` 解析失败 | 隐式 project 写入被拒绝并给出提示，不落 own |

无法在现阶段验证的：桌面端 `node:sqlite`（用例 8/9 的桌面形态）、崩溃注入点（需实现留钩子）、win32 大小写（可单测，实现期做）。

## 成本与风险

- 运行成本：索引为本地文件，查询无网络；复盘每条候选一次模型调用，可设上限；无 embedding 调用成本。
- 存储：索引与 Markdown 同量级；项目记忆随项目数线性增长。
- 风险：
  - 项目 id 随路径变化（搬动即新项目）——已定规则，靠提示而非自动合并。
  - 词面检索不覆盖同义改写——写进已知限制，不靠索引假装语义。
  - 桌面端 sqlite 未实测——只影响「已验证平台」表述，失败时自动降级为扫 Markdown。
  - 历史 own/team 污染无法自动清理——人工整理。

## 已知限制

- 纯词面检索无法保证「换说法也能找到」；提升命中靠条目措辞、`kind: howto`、`source` 锚点，不靠索引。
- `verified` 只表示「有可复核引用且引用支持该主张」，不是客观真理。
- 同大小同时间戳的手工改写无法在运行期发现，需显式重建索引。
- 项目搬动会产生新 id，旧记忆需用户确认复用。
- 历史 own/team 中的项目内容不会被自动隔离。

## 尚未解决 / 未完成（设计层面已无阻塞；以下为「已定但未实现/未验证」）

1. **插件工程师完整报告缺失**：429 中断，未交完整核实报告。已由 Chief 复核并写入本稿的部分：`waits` 参数是 work id 而非 Bot id、`state.questions` 以 Session id 为键、`commit` 是唯一写漏斗、`archiveBotMemory` 走 `rename` 旁路、worktree 的 `.git`/`commondir` 实测格式。**这不影响设计结论**，影响的是「哪些行号由多人独立复核」这一证据强度。
2. **测试注入点**：需在实现中预留，属实现验收项。
3. **DSH 桌面 Electron 端 `node:sqlite`**：未实测。运行时探测 + Markdown 降级已定死，故不阻塞设计；只影响「已验证平台」的表述范围。
4. **JiuwenSwarm 分支对照**：资料员核对的是 `main`，此前参考是 `develop`，**未固定同一 commit**。因此「全仓没有项目/经验记忆」这一结论降级为「`main` 上未见，`develop` 待核」，**且本设计不依赖它**（见下节说明）。

## 与 JiuwenSwarm 的关系

**结论：本设计不引用它作为依据。** 项目作用域与任务复盘按**原创补齐**处理；对外文档中不出现「他们已实现、我们照做」的表述。

**资料员的核对结果（分支未对齐，仅作参考，不作证据）**

资料员核对的是 `main`（默认分支 `develop`，两者未固定到同一 commit）。以下条目均应按「`main` 上所见」读，不得推广为「JiuwenSwarm 全仓没有」：

- `main` 的记忆模块为 8 个文件（`agentserver/memory/`），作用域是 agent 级单目录（`workspace/agent`），`_validate_memory_path` 只放行 `memory/` 前缀；未见项目/仓库维度。
- `main` 的「任务经验」只有 `tools/todo_toolkits.py` 的 `TodoToolkit`（`workspace/session/<id>/todo.md`，`TaskStatus` = waiting/running/completed/cancelled，`result` 为模型自由文本）；未见证据校验、回写记忆或复盘晋升。`evolution/` 是技能自演进，不是任务经验。
- 此前被当作「检索排除已注入层」依据的 `manager.py:788-789` 实为 `search()` 的 docstring；`_is_recent_session_file`（L545）定义后零调用；真正生效的是 `_build_source_filter`（L1026-1035）。这条本身与分支无关（是同一文件的实现细节），但**同样不构成可用先例**。
- 行号纠错：`minScore` 默认来自 `config.py` 的 `query.minScore=0.3`（`manager.py:803` 的 `0.7` 只是缺省兜底）；混合权重在 `manager.py:836-837`。

**即便 `develop` 上存在更完整的实现，也不改变本设计**：项目身份、索引、复盘各自的依据都在本仓库源码里（`folders.js`、`chat-index.js`、`memory-files.js`、`handoffs.js`），DSH 公开 API 的边界已逐条核实。借不借得到先例，可行性论证不变。

**无代码或文本复制。** Chief 复核：`git grep` 与全树文件搜索 `MemoryIndexManager|chunks_vec|chunks_fts|build_fts_query|TodoToolkit|EMBEDDING_CACHE_TABLE|vector_to_blob|list_memory_files|is_memory_path` 均无命中（`docs/dev-artifacts/scratch/` 未入库，其中 `jiuwenswarm-memory.md:24` 只是引用表名做对比）。产品侧为 Apache-2.0 / Python，本插件为 JS，无共享代码。

## 评审状态

**两种状态必须分开读：**

- **设计结论：通过。** 架构、边界、数据模型、状态机、权限规则、降级链已定死，不再有留给实现期猜的选择项。
- **代码：尚未实现；运行测试：待实施。** 本稿是设计文档，不含任何已上线行为。

### 逐项关闭记录

| # | 评审问题 | 处置 | 状态 |
|---|---|---|---|
| 1 | 存储根写成 `<DSH_HOME>/memory` | 改为 `<botHome>/memory`，默认 `<DSH_HOME>/bot/memory`（`index.js:52` + `memory.js:504`） | 关闭 |
| 2 | 目录名用 `proj:<hash>`（Windows 冒号非法） | scope key 用 `project:<hash>`，目录用纯 16 位 hex | 关闭 |
| 3 | 同步与异步两套算法会产生不同 id | 合并为单一同步 `resolve(cwd)`，读写同一入口；结果按 cwd 缓存 | 关闭 |
| 4 | 解析失败会把项目内容落进全局 own | `unresolved` 时拒绝隐式 project 写入并说明原因 | 关闭 |
| 5 | `.git` 文件无 `commondir`（子模块/分离 gitdir） | 回落用 `gitdir` 本身，判定顺序固定 | 关闭 |
| 6 | 自动 review / 面板绕过隔离 | 新增 `writeScopeOf(sessionId, requested)` 单一判定点，`memory.js:1259/1290/1417` 全部改走它 | 关闭 |
| 7 | 面板 project 归属靠猜会话 | 面板显式携带 `project`，服务器校验三项后落库 | 关闭 |
| 8 | 一个候选多条 claims，崩溃后漏写 | 选定**逐项 `entryId` 恢复**；提交粒度不参与恢复判定 | 关闭 |
| 9 | `sessionId + callId` 的保证过强 | 限定为「同一次工具调用重放」，换段重调靠内容去重，并写明边界 | 关闭 |
| 10 | 把 caught-error 回滚误当断电原子性 | 明确指出 `commit` 只保证进程内异常回滚；恢复不依赖它 | 关闭 |
| 11 | 索引缺 `added` 字段 | 已补进 `entries` 表 | 关闭 |
| 12 | 内容哈希无存放位置 | 已指定 `index-hashes.json` | 关闭 |
| 13 | 「40 个主题 / 毫秒级」表述不准 | 40 是每 scope 上限（`memory.js:37/652`）；删除未测量的性能断言 | 关闭 |
| 14 | 桌面端 sqlite 被当成 P0 授权阻塞 | 改为运行时能力探测 + Markdown 降级；已实测 DSH Web（Node 24.20.0 / SQLite 3.53.4 / FTS5 trigram 可用） | 关闭 |
| 15 | 两字中文词在 trigram 下召回为 0 | 已实测确认，`LIKE` 回退为必需项（与 `chat-index.js:23-42` 一致） | 关闭 |
| 16 | JiuwenSwarm 分支未对齐 | 「全仓没有」降级为「`main` 上未见，`develop` 待核」，且本设计不依赖该结论 | 关闭（降级处理） |
| 17 | 插件工程师报告缺失 | 如实保留；已核部分以 Chief 复核名义写入，不影响设计结论 | 关闭（证据强度备注） |

**未关闭的都不是设计问题**：测试注入点（实现期预留）、桌面端 sqlite 实测（只影响「已验证平台」表述）、`develop` 分支对照（外部资料，本设计不依赖）。

## 评审结论（四角色）

- **架构师**：给出 V2 总体设计（三文件、三态状态机、scope 白名单、快照冻结共存）。Chief 采纳其模块划分与状态机，修正其证据闸（不再四条件 AND）、`waits` 签名、索引失效方式、非 Git 根判定。
- **插件工程师**：核实到源码级并实测了 worktree 的 `.git`/`commondir` 格式；429 中断，未交完整报告；关键结论由 Chief 复核补入。
- **测试工程师**：提出 T1–T5 与崩溃注入方案，指出 `isError` 与 `exitCode` 的判定缺口；按后续纠正，本稿改为**按主张逐条判定**（见第 3 节表格）。其 T2/T5 已被证伪并替换。
- **资料员**：本轮交付。在 `main` 上未见项目维度的记忆、未见任务经验实现（只有 `TodoToolkit` 的会话待办）；并纠正此前把 `manager.py:788-789` 的 docstring 当作可用机制的错误。**分支未对齐**（参考用 `develop`，核对用 `main`），结论按「`main` 上未见，`develop` 待核」处理，且本设计不依赖它；项目作用域与任务复盘按**原创补齐**。

## 变更

- 2026-10-22：初稿。按最终口径删除全部向量/embedding 内容；完成判定改为显式候选 + 按主张的证据核验；索引一致性改为已提交视图 + 写入漏斗标脏 + 显式重建。
- 2026-10-22（修订 2）：按评审意见修正存储根、目录名、单一规范化算法、`.git` 无 `commondir` 的回落、第一方写入的 project 传递、多 claims 幂等、索引字段与哈希位置；删除未测量的性能断言；新增「评审状态」一节，明确本次评审**未全部通过**。
- 2026-10-22（修订 3）：按资料员核实结果新增「与 JiuwenSwarm 的关系」，把对外引用降级为「文档意图 / 未接线」，项目作用域与任务复盘改为原创补齐；补记无代码复制的外部复核方式；「尚未解决」项相应减少一条。
- 2026-10-22（修订 4）：收回桌面端探针这一人为授权阻塞，改为运行时能力探测 + Markdown 降级，并实测 DSH Web 的 Node/SQLite/FTS5 trigram 能力与两字中文词的召回缺口；面板改为显式项目上下文 + 服务器校验；幂等恢复定死为逐项 `entryId`，并澄清 `commit` 不是断电原子；JiuwenSwarm 结论按分支未对齐降级；评审状态改为「设计结论通过 / 代码未实现」两段式，并补逐项关闭表。
