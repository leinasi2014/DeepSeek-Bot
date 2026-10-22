# 记忆功能的验收证据

- 日期：2026-10-22
- 相关：#51（总任务）、#52 项目隔离、#53 本地全文检索、#54 任务复盘、#55 集成验收
- 设计：`docs/plans/2026-10-22-memory-isolation-retrieval-review.md`（提交 `ae8308d`）
- 说明：本文件只记可核对的证据。**「实测」= 有对应命令输出或日志；「推断」= 由代码读出来的结论，没有跑过；「未验证」= 这次没做。**

## 口语约定

- `verified`：有可复核的引用，且该引用支持这条主张。它不是客观真理。
- 全流程**不使用**向量、embedding 或向量库；检索只做词面匹配。

## 证据总表

| 项 | 状态 | 证据 | 备注 |
|---|---|---|---|
| 既有代码基线（未合并新功能时） | 实测 | `npm test` 727/727 | 只证明基线没坏 |
| #52 单测与行为测试 | 实测 | `npm test` 744/744（修复前）→ 745/745（`d4ca7d9`）→ 746/746（`5542df2`）→ **746/746**（当前头 `27e599b`，我本机实测 pass 746 / fail 0 / skip 0）；含 A/B 项目零泄漏、worktree 同 id、子模块独立 id、unresolved 拒写、快照 scope 头、面板越权 session 拒绝、review 路径 skip + journal、project 目标 edit/move/remove 各一条 | 当前头 `27e599b` 已 revert `5542df2` 的 team 修复，测试数同为 746 是巧合（+1 用例 −1 用例） |
| #53 接线后全量测试 | 实测 | `npm test` 755/755；`build-client --check` 退出 0；`npm run lint` 退出 0 | 见 `feat/53-memory-index` 的 `2943fc2` |
| #54 接线后全量测试 | 实测 | `npm test` 761/761（`cd7bd21`）→ 762/762（`7c61fd7` 补 file 路径校验）→ 773/773（并入 `d4ca7d9`）→ **776/776**（`1eb28cc`，并入 #53 索引 11 例 + HELD/补证 3 例）；`lint` 0、`build-client --check` 0。我在本机对 `1eb28cc` 干净树复跑：**776 pass / 0 fail / 0 skip** | 工作区另有未提交改动时全量为 779/777/2 fail，失败项是 `a relative file claim is judged against the cwd frozen at enqueue`——属在补的功能，不是 `1eb28cc` 的回归 |
| `node:sqlite` + FTS5 trigram 在 Node 侧可用 | 实测 | 设计 §8 记录的探针：建表、长中文 MATCH、短中文 LIKE、scope 过滤均通过 | 只覆盖 Node/Web 侧 |
| **桌面 Electron 端的 `node:sqlite`** | **未验证** | 无 | 本机无 DSH 的 `app/` checkout，跑不了探针；桌面端必须走扫描回退 |
| 原生 Windows 隔离 smoke | **未验证** | 无 | `dev/bench.sh` 需要 `deepseek-harness` checkout 与本机不符，尚未跑；不得计为通过 |
| 面板 UI 截图 | **未验证** | 无 | 依赖 UI 构建与真实界面，尚未截图 |
| 同大小同 mtime 的手工改写可被发现 | 推断 | 设计 §4 规定以内容 hash 为唯一新鲜度依据，不用 mtime/size | 待 #53 用例实测 |
| 归档后清理死 scope 的索引行 | 推断 | #53 实现里有显式回收，见 `memory-index.js` 与归档调用点 | 待用例实测 |
| 强杀后逐项续写、每条恰好一次 | 推断 | 设计 §6 的逐项状态机与固定 `review_id`；`task-review.js` 有 `HELD` 与逐候选 `task-plans/<id>.json` | 仍待故障注入实测（强杀点尚未注入） |
| 被闸门拒掉的教训只留候选、不进 Markdown | 实测 | `7c61fd7`：`record.unverified` 记 `reason`（`evidence-unsupported`/`evidence-missing`/`entry-problem`/`secret`/`model-unsupported`）与原文，只留在 `task-plans/<id>.json`。用例「the memory review…」（file 越界）断言 `unverified[0].reason === 'evidence-unsupported'` 且未写记忆；模型判 no 时断言 `model-unsupported` | — |
| 拒掉的候选不冻结空计划、不标 DONE，空闲不自动重试 | 实测 | `1eb28cc` 引入 `HELD`（`task-review.js:39/268/297`）：`process` 对 `HELD` 直接返回，空闲不再烧模型调用。用例「a task whose lessons are all refused waits for an explicit retry」 | — |
| 显式补证入口存在，且不复用已冻结计划重抽 | 实测 | `1eb28cc`：新 endpoint `memory-task-retry`（`channel.js` 放行），`retry(id)` 后只对该会话跑一次；`:318` 对已有 `plan !== null` 直接拒绝重抽。用例「an explicit retry reopens a held task, and a frozen one is never extracted again」「a candidate with a frozen plan ignores the explicit retry」 | — |
| 任务完成的判定不依赖 `isError` 字段本身 | 推断（已定为边界） | 设计 §5 已写明 `isError:false` 本身不等于成功。现实现取「同会话 `partLines` 的 part/seq 日志 + 渲染文本里的 `[exit code: N]`/`[timed out`/`[killed by signal`/`[stderr]` 标记」+ `toolReportedFailure` 进语义核验；未直接从 `tool/result` 事件读结构化 `isError` | 按 Chief 2026-10-22 决定列为**已定边界**，不作未完成项；出现具体反例再改 |
| 项目无法判定时不落 own（工具路径） | 实测 | #52 的 `memory-project.test.js`：unresolved 拒绝隐式写入 | 见 #52 分支 |
| 项目无法判定时不落 own（自动复盘路径，add） | 实测 | `d4ca7d9`。skip 判定在 `memory.js:1566`：`op === 'add'` 且非显式 `team`，或 `target?.scope === 'project'`；命中即 `journal({op:'skip', scope:'project:unresolved', reason:'project-unresolved', problem})` 后 `continue`，不再走 `:1582-1583` 的 `ownScope` 回落。用例「the memory review skips project writes when the project is unresolved, and journals them」用 broken gitdir（`.git` 写 `gitdir: ../nowhere`）真走 review 通道，断言 `memory/bots/b2` 不存在、team 那条仍落盘、`problem` 含 `nowhere`、`after` 存全文 | — |
| edit/move/remove 在 unresolved 时不改投 own | **代码复核；公开路径不可达，不计入 pass** | 代码：`memory.js:1566` 的 guard 覆盖 `target?.scope === 'project'` 的 edit/move/remove。但该分支经公开 review 路径**不可达**——`memory.js:1713` 在 `project.status !== 'ok'` 时 `projectFiles = []`，`reviewEntries` 的 `numbered` 里不可能出现 project 条目，模型无从引用；`ok` 又按进程内缓存，读时 ok、apply 时仍 ok。仅当「缓存失效且恰在两步之间换状态」的理论窗口成立。`edb6345` 里那条用例靠 `clearCache()` 人工制造该窗口，`5542df2` 后被 `27e599b` 连带删除 | 纵深防御，**不作为功能已覆盖**；Chief 2026-10-22 定：不导出测试缝 |
| 显式 `team:true` 但 Bot 无 team 写权限时落到 own | **`5542df2` 曾修（skip + journal），但当前头 `27e599b` 已 revert，状态待定** | 事实链：`5542df2` 实现 skip + `journal({scope:'team', reason:'team-write-denied'})`，并有一条非 Main Bot fixture 用例（own 与 team 目录都不创建、journal 带 reason）；随后 Chief 改判「既有行为、本次不改」，架构师照办 `27e599b` **revert**，`memory.js` 已无 `team-write-denied` 分支，用例一并删除。当前 `origin/feat/52-project-scope` = `27e599b`，本机实测 `npm test` **746/746 pass / 0 fail** | Chief 最新又要求「team 修复记 `5542df2`」，与代码撤回态冲突；需先 revert 该 revert 才能按「已修复」记录 |

**结论：上表中「实测」的项只覆盖测试套件与静态检查；新功能的隔离 smoke、UI 截图、桌面端探针都还没有跑。不要把本文件里的 745/755/762/773/776 读成新功能验收通过——它们只是各分支不同阶段的全量测试数，且都在本机临时目录里跑；各分支尚未合入 `dev`，合入后数字还会变。**

## 怎么自己复核

```sh
cd ds-bot
npm test                      # 全量测试
npm run build-client --check  # 客户端构建检查
npm run lint
```

测试全部写在临时目录（`.dsh-test-*`）里，用 `dev/mock-llm.mjs` 当模型，不需要任何密钥，也不会碰 `~/.dsh`。

注意：单跑某个文件时必须经仓库的 harness 加载器，否则 `@deepseek-ai/*` 解析不到。

```sh
node --experimental-test-module-mocks --import ./test/harness-resolve.mjs --test test/memory-project.test.js
```

## 设计 §7 验收条目 → 测试映射

设计 §7 有 10 组、共 40 余条断言。下表说明每一条现在由谁负责，**删掉的 skip 也记在这里，不留空白**。状态列：`实测` = 有用例且跑过；`skip` = 用例已在 `memory-acceptance.test.js` 占位、尚未实现；`由 #52 覆盖` = 不重复造用例，指向已有文件。

| §7 组 | 条目要点 | 现由哪个测试负责 | 状态 |
|---|---|---|---|
| 身份 | 仓库根等于 teamFolder 仍为项目 | `project-scope.test.js`「the team workspace that is a repository is a project」 | 实测 |
| 身份 | ds-bot 子目录找到父 Git；monorepo 标记不覆盖 Git | `project-scope.test.js`「Git wins over a package.json on the way up」、「a plain repository is one project from any folder inside it」 | 实测 |
| 身份 | worktree 同 ID；普通 submodule 不同 ID | `project-scope.test.js`「a worktree of a repository shares its identity, a submodule does not」 | 实测 |
| 身份 | 绝对/相对 gitdir 与 commondir；断链为 unresolved | `project-scope.test.js`「a relative gitdir pointer resolves against the folder holding the .git file」、「a broken gitdir pointer is unresolved, not absent」 | 实测 |
| 身份 | 无 Git 深层目录不被层数切开；标记物不被父目录吞掉 | `project-scope.test.js`「markers name the project when there is no Git, from any depth」、「a marker above the team folder does not swallow folders below it」 | 实测 |
| 身份 | none/unresolved 后补 Git 能恢复；真实大小写；hash 碰撞拒绝 | `project-scope.test.js`「answers expire, so a folder that gains a repository is found again」、「a missing folder is unresolved and the case of a folder is the case on disk」、「the session scope serves reads and writes, and refuses a hash collision」 | 实测 |
| 范围 | A 写 B 零可见 | `memory-project.test.js`「a Session saves to its project by default, and only its project is visible to it」 | 实测 |
| 范围 | 所有第一方入口默认 project；显式 own/team 仍可用 | `memory-project.test.js`「an explicit own or team scope still writes there, from a project session」；`memory-acceptance.test.js`「scope: the automatic review defaults to project and rejects unresolved」 | 实测 |
| 范围 | 显式 team 仍须通过原有授权 | 授权失败时的落点：`5542df2` 修成 skip + journal，`27e599b` 又 revert 回落 own。当前代码为落 own，见上方证据表同名条目 | **待定**（代码与裁定不一致） |
| 范围 | project 目标的 edit/move/remove 在 unresolved 时不改投 own | 代码复核 `memory.js:1566`；公开路径不可达（`memory.js:1713`），不作功能覆盖 | 代码复核，不计入 pass |
| 范围 | unresolved 不落 own（工具/面板/复盘三路） | `memory-project.test.js`「a session whose project cannot be told apart writes nothing by default」；`memory-acceptance.test.js`「scope: an unresolved project never falls back to own, tool or panel」 | 实测 |
| 范围 | 面板假 hash/错 session 拒绝；项目列表由服务端算 | `memory-acceptance.test.js`「scope: the panel project list is server-computed from the Bot's own sessions」、「scope: the panel writes a project entry only through a session that works in it」 | 实测 |
| 缓存 | 旧快照失效；scope 或 teamRule 变化重建 | `memory-project.test.js`「the frozen section names its scopes and shows the project memory」（断言 v2 头带排序后的 scope 集合）；`memory.test.js`「a Session keeps the memory it began with, across restarts, until its snapshot goes」「a change of role freezes the section again, so its team rule matches the tools」（快照跨重启保持、快照删除后重建、角色变化重建） | 部分实测：**已有**scope 集合进快照头、teamRule 变化重建、快照失效重建；**缺**「scope 集合变化→立即重建」与 A→B→A 的独立断言 |
| 缓存 | 普通内容仍冻结 | `memory.test.js`「a Session keeps the memory it began with, across restarts, until its snapshot goes」（写入后 `section` 逐字不变） | 实测 |
| 缓存 | 所有摘要缓存含范围；A→B→A 旧异步回包丢弃 | `memory-acceptance.test.js` 3 条 `cache:` skip（其中「old snapshots invalidate…」部分已被上面两条覆盖，但 scope 变化重建与 A→B→A 无独立断言） | skip |
| 检索 | 空查询/整 topic/全词优先/中文 1-2-3 字/转义/稳定排序/白名单在 LIMIT 前/索引失败扫描兜底 | 大部分由 `memory-index.test.js`（#53）11 例覆盖：「a long term is matched by the index and a short Chinese term falls back to a literal pass」（长词走索引、中文短词走字面）、「the scope whitelist filters before the limit」、「every word must match first, then the rows with the most words」、「quotes, percent, underscore and backslash are literals, not query syntax」、「without SQLite the same snapshot is scanned, and the answer is not empty」、「a Markdown read that fails twice is reported, never answered with an empty list」。空查询与整 topic 两条仍留在 `memory-acceptance.test.js` 的 `retrieval:` skip | 大部分实测；空查询/整 topic **skip** |
| 一致性 | move 中间态不可见；删除/归档/同 size+mtime 手改可发现；死 Bot 清理；SQLite 损坏可重建 | `memory-index.test.js`「a file that disappears loses its rows, and an edited file is rebuilt from its hash」（删文件/按 hash 重建）、「a deleted index file is rebuilt, and the same query answers again」、「a failed refresh publishes nothing and the recall still answers from the snapshot」、「cleanup drops the rows of deleted Bots and keeps team and project scopes」（死 Bot 清理）；move 中间态由 `memory-read-commit.test.js` 改写后的队列内同步读断言覆盖 | 实测（#53） |
| 验收 | idle/换段/溢出不触发；伪造完成不判成功；短确认可验 | `memory-acceptance.test.js` 3 条 `acceptance:` skip | skip（等 #54） |
| 权限 | 跨 Bot/项目锚点、`../`、同前缀、junction 拒绝；执行前重校验；secret 不外泄 | `memory-acceptance.test.js` 3 条 `permissions:` skip | skip（等 #54） |
| 等待 | 相关 work/question 等待；其他群不阻塞；换段仍等待；`memoryReview:false` | `memory-acceptance.test.js` 3 条 `waiting:` skip | skip（等 #54） |
| 恢复 | 强杀重放；跨天 meta 不漂移；双道校验；同 ID 一次；changed:false；冲突不覆盖；`memory/full` | `memory-acceptance.test.js` 7 条 `recovery:` skip | skip（等 #54） |
| 上限 | 8 条主张、输入上限、批量预算、重试退避、新 callId 不冒充同候选 | `memory-acceptance.test.js` 2 条 `limits:` skip | skip（等 #54） |

**已删除或未建的 skip 及其去处**：身份组原先在 `memory-acceptance.test.js` 里有 10 条 skip，**全部删除**，理由是 `project-scope.test.js` 的 12 例已逐条覆盖上面「身份」那 6 行——**不重复造第二套断言**，此处保留映射即为其记录。其余组仍是 skip，逐条列在上表，不视为通过。

**当前 skip 总数**：`memory-acceptance.test.js` 里 **30 条**（缓存 3、检索 5、一致性 4、验收 3、权限 3、等待 3、恢复 7、上限 2；用 `Select-String -Pattern 'test\.skip\('` 实数为 30）。这些**一条都不算通过**。其中一部分的实质覆盖已在 #53/#54 的独立用例里（见上表「检索」「一致性」两行），但**在 feat-55 里它们仍是 skip**，要转成真断言才算关闭——Chief 已要求最终验收前不能留 30 条 skip。

## 外部参考的核实方式

固定 commit `6037f8e3b91d657f5eac80ef764b41ce511499dc`：

- `jiuwenswarm/common/coding_memory_paths.py`（80 行）：`resolve_project_coding_memory_dir()` 给出 `<agent_workspace>/coding_memory/<project_name>-<path_hash>`；`resolve_coding_memory_project_name()` 在 43–67 行对规范化后的绝对路径取 sha256 前 12 位做目录后缀，文件名部分做字符清洗。→ **项目路径隔离是已实现代码，不是文档描述。**
- `jiuwenswarm/agents/harness/common/tools/task_tools.py`：任务经验写进任务数据文件。

**这不等于它的任务结果做了证据验收。** 本次没有复制任何外部代码或文本，只借鉴「以目录/仓库为项目边界、按路径 hash 分目录」这一条思路；证据验收规则是本项目自己的设计。
