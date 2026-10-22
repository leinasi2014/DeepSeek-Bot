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
- 项目 id = `proj:` + `sha256(规范化后的 common dir)` 前 16 位；`win32` 上先转小写。

主仓库与它的所有 worktree 因此得到同一个 id。已实测：worktree 的 `.git` 文件为 `gitdir: D:/.../main/.git/worktrees/wt`，`<gitdir>/commondir` 为 `../..`，`git rev-parse --git-common-dir` 返回主仓库 `.git`。

**非 Git 目录**

- 从工作目录向上找**最近一层**含标记物的目录：`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml`、`*.csproj`。
- 都没有：以工作目录本身为根。
- 项目 id 算法同上（对根目录 realpath 取 hash）。

**Windows 大小写**

- 仅在 `process.platform === 'win32'` 时把 realpath 结果转小写再取 hash；不做文件系统大小写探测，不做路径前缀替换。其他平台原样。
- 适用范围写进注释与单测：两种大小写写法必须得到同一 id。

**同步解析**

提示词 section 是同步的（`dsh-system-prompt/lib/types/index.d.ts:60`：`text: string | ((context) => string)`），所以项目身份必须能同步取到：

- `resolveSync(sessionId)`：`ctx.sessions.get(sessionId)?.header?.cwd`（`dsh-session/lib/types/index.d.ts:447`；`session.header` 始终存在，同文件 `:116-119`）。
- 异步 realpath 只用于**写入时**校正与 `projects.json` 更新。
- 同步解析失败一律按「无项目」处理，不阻塞提示词渲染、不报错。

**搬动与重命名**

- `projects.json` 只记录 `id → 明文路径 + 最后确认时间`，不参与判定。
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
- 候选 id = `sessionId + callId`（`exec.callId` 在 `dsh-tools/lib/types/index.d.ts:217` 为只读必填），重启、换段、重试均不变。

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

**幂等**

- 写入条目时，journal 记录带 `candidate: <id>`。
- 恢复判据：**journal 中已有该候选的条目写入记录，即视为已入库**（`commit` 先改文件并追加 journal，二者同一次提交），补写 `reviewed` 标记即可；没有记录则重做。
- 因此「写记忆成功、写标记前崩溃」不会重复写入；「标记写了但条目没写」不可能出现，因为标记只在条目提交之后写。
- 同一任务重复提交：候选 id 相同直接跳过；不同 id 但内容相同，由现有 `matchEntries` 整句比对返回 `changed:false`（`memory.js:646-647`）兜底。

### 4. 存储与数据模型

```
<DSH_HOME>/memory/
  bots/<botId>/MEMORY.md + <topic>.md     现有，不动
  team/MEMORY.md + <topic>.md             现有，不动
  projects/<projectId>/MEMORY.md + <topic>.md   新增，结构与上面同构
  journal.jsonl                            现有；新增 op: task-candidate / task-review
  snapshots/                               现有，按 Session 冻结
  reviewed.json / rejections.json          现有
  projects.json                            新增：id → 明文路径
  index.sqlite                             新增：可重建的派生索引
  index-dirty.json                         新增：待刷新范围（持久化）
```

索引表：

```sql
CREATE VIRTUAL TABLE entries USING fts5(text, scope UNINDEXED, file UNINDEXED, line UNINDEXED, tokenize='trigram');
CREATE TABLE files (scope TEXT, file TEXT, mtime REAL, size INTEGER, PRIMARY KEY (scope, file));
```

- `trigram` 分词：中文三字以上无需切词；两字以下回退 `LIKE`（照 `chat-index.js:23-42` 的手法）。
- 权限过滤在 SQL 层：`scope IN (<本次白名单>)` 先过滤再 `MATCH`。白名单由调用方传入，索引内容不参与权限判断。
- 排序只有两条：`rank`（BM25），同分按 `own > project > team`，再按 `added` 新到旧。不预置短语加权，等测试数据说话。

### 5. 索引一致性

- **只读已提交视图**：用 `memory-files.js:132` 导出的 `read`/`list`，它们覆盖 `pending`（未提交写入）并排除回滚。索引构建与刷新一律经过它们，不直接 `fs.readFile`。
- **写入触发失效**：`commit()` 成功返回时回调 `onCommitted(paths)`，把路径并入 `dirty`。现有三个写入口（`memory.js:670/704/720`）全部经过 `commit`，面板写入同样经过它。
- **旁路也要标脏**：`archiveBotMemory`（`memory.js:800`）走 `rename`，必须单独标脏并删除该 scope 的索引行。
- **刷新时机**：每次 `recall` 前先 flush `dirty`：重扫这些文件的**全部行**，不是只补命中项——否则「新增条目」和「改写后命中查询词」都会漏。
- **删除兜底**：查询命中后对命中文件做存在性检查，文件已不存在则丢弃该批行并标脏。
- **启动时**：索引缺失或版本不符则全量重建；随后对全部记忆文件做一次**内容哈希比对**（约 40 个不超过 16k 的文件，毫秒级），覆盖「运行期外被改写」。
- **运行期手工改写**：`mtime + size` 无法可靠发现同大小同时间戳的改写。**明确提供显式重建**（记忆面板的「重建索引」或对应端点），并在已知限制中写明。这是本设计的已知缺口，不用轮询伪装成已解决。
- **索引更新失败**：该 scope 标脏并**整体回退到扫 Markdown**（现有 `recall` 逻辑，`memory.js:1092-1105`），下次再试。绝不返回半新半旧的结果。

### 6. 工具与接口的最小变化

| 变化 | 内容 |
|---|---|
| `complete_task`（新工具） | 只记录候选与主张，不写记忆 |
| `recall` | 默认范围加 project；输出加 `project` 标签与 `outcome`；新增可选 `scope: "project"` |
| `remember` / `forget` / `move` | 签名不变；`scope` 接受 `"project"`；有项目时默认目标为 project |
| 记忆面板 | 显示条目 `outcome` 与证据；新增「重建索引」动作 |
| 配置 | 只加一项 `projectMemory`（默认开）。理由是回退开关：出错时能整体关掉项目范围而不影响现有记忆 |

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

1. **P0 前置探针（阻塞项）**：在 DSH 桌面 Electron 端跑一个只 `await import('node:sqlite')` 的探针插件，确认可用或有降级。这是索引方案的前提假设，未验证前不进入 P2。
2. **P1 项目隔离**：`project-scope.js` + project 存储 + `recall`/`remember` 的 scope + 提示词。此时仍用现有子串检索，功能可独立验收。
3. **P2 全文索引**：`memory-index.js` + dirty/已提交视图 + 显式重建 + 面板动作。
4. **P3 任务复盘**：`complete_task` + `task-review.js` + 证据核验 + 幂等。
5. **P4 验收与文档**：补齐用例、`docs/plans` 定稿、README 行为说明（英文与中文同步）。

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
| 2 | 同仓库两个 worktree 各写一条 | 落在同一 `projects/<id>`；相互可见 |
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
| 15 | 写记忆成功后、写标记前崩溃，重启再提交同候选 | journal 中该候选条目恰一条 |
| 16 | 子任务未回 / 问题待答 | `WAITING`，不计数、不丢弃；子任务交回后继续 |
| 17 | 三次语义无效 | `SKIPPED`，journal 带全文，可人工补记 |
| 18 | 密钥形态文本 | 永不入库（复用 `looksSecret`） |

无法在现阶段验证的：桌面端 `node:sqlite`（用例 8/9 的桌面形态）、崩溃注入点（需实现留钩子）、win32 大小写（可单测，实现期做）。

## 成本与风险

- 运行成本：索引为本地文件，查询无网络；复盘每条候选一次模型调用，可设上限；无 embedding 调用成本。
- 存储：索引与 Markdown 同量级；项目记忆随项目数线性增长。
- 风险：
  - 项目 id 随路径变化（搬动即新项目）——已定规则，靠提示而非自动合并。
  - 词面检索不覆盖同义改写——写进已知限制，不靠索引假装语义。
  - 桌面端 sqlite 未验证——P0 探针卡口。
  - 历史 own/team 污染无法自动清理——人工整理。

## 已知限制

- 纯词面检索无法保证「换说法也能找到」；提升命中靠条目措辞、`kind: howto`、`source` 锚点，不靠索引。
- `verified` 只表示「有可复核引用且引用支持该主张」，不是客观真理。
- 同大小同时间戳的手工改写无法在运行期发现，需显式重建索引。
- 项目搬动会产生新 id，旧记忆需用户确认复用。
- 历史 own/team 中的项目内容不会被自动隔离。

## 尚未解决 / 未完成

1. **桌面 Electron 端 `node:sqlite`**：`chat-index.js:76`、`usage.js:241` 只证明了 Node/Web 侧；当前 `dev` 无 `app/` 目录（`git ls-tree -d dev` 仅 `.agents/.github/docker/docs/ds-bot/scripts`），无法查 Electron 版本。列为阻塞前提。
2. **资料员核实未完成**：JiuwenSwarm 本地无克隆，模型侧遇 429 限流。本设计不依赖其结论：只借鉴方向性思路（以仓库/目录为项目边界、任务经验复盘），未复制其代码或文本；待其恢复后补出处与「已实现 / 文档描述」的区分。
3. **插件工程师核实未完成**：429 中断；已核部分由 Chief 复核并写入本稿（`waits` 参数是 work id、`state.questions` 以 Session id 为键、`commit` 是唯一写漏斗）。
4. **测试注入点**：需在实现中预留，属实现验收项。

## 评审结论（四角色）

- **架构师**：给出 V2 总体设计（三文件、三态状态机、scope 白名单、快照冻结共存）。Chief 采纳其模块划分与状态机，修正其证据闸（不再四条件 AND）、`waits` 签名、索引失效方式、非 Git 根判定。
- **插件工程师**：核实到源码级并实测了 worktree 的 `.git`/`commondir` 格式；429 中断，未交完整报告；关键结论由 Chief 复核补入。
- **测试工程师**：提出 T1–T5 与崩溃注入方案，指出 `isError` 与 `exitCode` 的判定缺口；按用户最后一条纠正后，本稿改为**按主张逐条判定**（见第 3 节表格）。
- **资料员**：未完成（见「尚未解决」第 2 条）。

## 变更

- 2026-10-22：初稿。按最终口径删除全部向量/embedding 内容；完成判定改为显式候选 + 按主张的证据核验；索引一致性改为已提交视图 + 写入漏斗标脏 + 显式重建。
