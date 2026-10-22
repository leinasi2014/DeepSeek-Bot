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
| #52 单测与行为测试 | 实测 | **X 定稿（保留 team 拒写）**。恢复提交 **`b6379c8`**（`git revert ed06b97`）：树 `44e60ac9f4d05bbd1291fcfd234776db3f57a125`（= `edb6345`/`e604034`），`team-write-denied` 命中 1；我实测全量 **747/747 pass / 0 fail / 0 skip**，`memory-project.test.js` 单跑 **8/8**。该支远端当前头是 `26be576`（树 `c9a70de5…`），我也单独跑过：**747/747**、8/8，两种头数字一致 | **该支所有推送均已成功**：`git reflog show --date=iso origin/feat/52-project-scope` 依次为 `26be576 @{19:56:53}: update by push`、`650bc5d @{19:54:33}`、`27d3555 @{19:53:57}`、`b6379c8 @{19:28:02}`、`ed06b97 @{19:14:49}`（全部 `update by push`）；本地 `feat/52-project-scope` 与 `origin/feat/52-project-scope` 同一提交、worktree `status --porcelain` 为空。`b6379c8` 之后三条**只改 `ds-bot/test/project-scope.test.js`**（`git diff --name-only b6379c8 26be576` 只有这一个文件），`ds-bot/src` 在 `b6379c8`/`27d3555`/`650bc5d`/`26be576` 四头 tree 全为 `ef0e48bd…`，**产品代码零改动**。**`27e599b`、`ed06b97` 是被覆盖的中间态，不作基准**：`ed06b97` 守卫命中 0 |
| #53 接线后全量测试 | 实测 | **`4b6f1eb`**（`Restore the team-write refusal, which the maintainer kept in scope`）：**758/758 pass / 0 fail / 0 skip**，`team-write-denied` 命中 **1**；check 0、lint 0 | 等价头：远端 ref 现为 `2e3e9b2`，两者树同为 `eee4328d…`，`4b6f1eb` 是其祖先（`merge-base --is-ancestor` exit 0），内容与数字一致。**Y 口径的本地提交 `9711664` 与 `a536786`（均命中 0）都未被任何分支引用**（`git branch -a --contains` 无输出），未上远端 |
| #54 接线后全量测试 | 实测 | **`114a4a0`**（`Merge the memory index branch with the team-write refusal restored`）：**782/782 pass / 0 fail / 0 skip**（连跑 3 次全绿），命中 **1**；check 0、lint 0。演进：761→762→773→776→779→782 | 等价头：远端 ref 现为 `0d8dac0`，两者树同为 `6d011389…`，`114a4a0` 为其祖先。含 `5be01ab` 的竞态修复；Y 口径的本地提交 `8c11b89`/`1f1c96f` 均未被任何分支引用。该竞态根因：产品先写 Markdown、之后才落 `DONE`（`task-review.js:230-257`），**`APPLYING` 是崩溃恢复的合法中间态**，属用例竞态而非产品缺陷 |
| `node:sqlite` + FTS5 trigram 在 Node 侧可用 | 实测 | 设计 §8 记录的探针：建表、长中文 MATCH、短中文 LIKE、scope 过滤均通过 | 只覆盖 Node/Web 侧 |
| **桌面 Electron 端的 `node:sqlite`** | **未验证** | 无 | 本机无 DSH 的 `app/` checkout，跑不了探针；桌面端必须走扫描回退 |
| 原生 Windows 隔离 smoke（加载 + 记忆基线） | **实测（SMOKE-PASS，exit 0）** | 云机 `170.106.141.48`，代码 `feat/55-acceptance @ 039e591`（含 X 态 `edb6345` 内容）；git bundle sha256 `3713C703…` → 克隆到 `C:\lab\src\DeepSeek-Bot-m55` → `npm ci` + `build` exit 0 → `dsh plugin --profile web add link:` exit 0；`127.0.0.1:3210`（web）+ `3211`（`mock-llm.mjs`），`DSH_HOME=C:\lab\bench-m55\.dsh-test-m55`，零真实密钥 | 断言：Main Bot 创建并应答；`记住 Alpha uses pnpm` 落入 bench home 内 `bots/<id>/MEMORY.md`；`回忆 Alpha` 正常；`memory/` 下有 `bots,journal.jsonl,reviewed.json,snapshots,team`；bench cwd 非项目 → **无 `projects` 泄漏**（符合设计）；写入全部限定在 bench home。归档：`C:\lab\runs\20261022-1930-qa-m55-load\`（MANIFEST / cmd.txt / result.txt / web.log / mock.jsonl），LOG.md 已记账。**范围仅限加载与记忆基线，不含新功能 acceptance**；那次加载的是 feat-55 的 `039e591`，此后该支 head 已推进到 `38b9392`（中间 `cb0468d` 曾含 team 守卫，`d0acd7b` 又删掉），**加载 smoke 未在新 head 上重跑** |
| 面板 UI 截图 | **未验证** | 无 | 依赖 UI 构建与真实界面，尚未截图 |
| 测试工具缺陷：`bench-memory` 的 probe 与 mock 日志不匹配 | **已定位（非产品缺陷）** | `dev/bench-memory.mjs:144-145` 读 tap 的 `status`/`text` 字段，而 `dev/mock-llm.mjs:634` 的 MOCK_LOG 只写 `out` 数组、无这两个字段，两者直接组合永远判 RateLimited；疑似 `bench-memory` 当年配 `dev/llm-tap.mjs`（真实模型、记 status）设计 | Chief 已批准按「兼容 mock 的 `out` 格式」或「明确挂 `llm-tap`」修改 `dev/` 脚本；**不动产品代码**。改完需在 #55 证据里补一句，此处同步更新 |
| 同大小同 mtime 的手工改写可被发现 | 推断 | 设计 §4 规定以内容 hash 为唯一新鲜度依据，不用 mtime/size | 待 #53 用例实测 |
| 归档后清理死 scope 的索引行 | 推断 | #53 实现里有显式回收，见 `memory-index.js` 与归档调用点 | 待用例实测 |
| 强杀后逐项续写、每条恰好一次 | 推断 | 设计 §6 的逐项状态机与固定 `review_id`；`task-review.js` 有 `HELD` 与逐候选 `task-plans/<id>.json` | 仍待故障注入实测（强杀点尚未注入） |
| 被闸门拒掉的教训只留候选、不进 Markdown | 实测 | `7c61fd7`：`record.unverified` 记 `reason`（`evidence-unsupported`/`evidence-missing`/`entry-problem`/`secret`/`model-unsupported`）与原文，只留在 `task-plans/<id>.json`。用例「the memory review…」（file 越界）断言 `unverified[0].reason === 'evidence-unsupported'` 且未写记忆；模型判 no 时断言 `model-unsupported` | — |
| 拒掉的候选不冻结空计划、不标 DONE，空闲不自动重试 | 实测 | `1eb28cc` 引入 `HELD`（`task-review.js:39/268/297`）：`process` 对 `HELD` 直接返回，空闲不再烧模型调用。用例「a task whose lessons are all refused waits for an explicit retry」 | — |
| 显式补证入口存在，且不复用已冻结计划重抽 | 实测 | `1eb28cc`：新 endpoint `memory-task-retry`（`channel.js` 放行），`retry(id)` 后只对该会话跑一次；`:318` 对已有 `plan !== null` 直接拒绝重抽。用例「an explicit retry reopens a held task, and a frozen one is never extracted again」「a candidate with a frozen plan ignores the explicit retry」 | — |
| 任务完成的判定不依赖 `isError` 字段本身 | 推断（已定为边界） | 设计 §5 已写明 `isError:false` 本身不等于成功。现实现取「同会话 `partLines` 的 part/seq 日志 + 渲染文本里的 `[exit code: N]`/`[timed out`/`[killed by signal`/`[stderr]` 标记」+ `toolReportedFailure` 进语义核验；未直接从 `tool/result` 事件读结构化 `isError` | 按 Chief 2026-10-22 决定列为**已定边界**，不作未完成项；出现具体反例再改 |
| 项目无法判定时不落 own（工具路径） | 实测 | #52 的 `memory-project.test.js`：unresolved 拒绝隐式写入 | 见 #52 分支 |
| 项目无法判定时不落 own（自动复盘路径，add） | 实测 | `d4ca7d9`。skip 判定在 `memory.js:1566`：`op === 'add'` 且非显式 `team`，或 `target?.scope === 'project'`；命中即 `journal({op:'skip', scope:'project:unresolved', reason:'project-unresolved', problem})` 后 `continue`，不再走 `:1582-1583` 的 `ownScope` 回落。用例「the memory review skips project writes when the project is unresolved, and journals them」用 broken gitdir（`.git` 写 `gitdir: ../nowhere`）真走 review 通道，断言 `memory/bots/b2` 不存在、team 那条仍落盘、`problem` 含 `nowhere`、`after` 存全文 | — |
| edit/move/remove 在 unresolved 时不改投 own | 实测（`edb6345` 的 test-only 提交，人工构造 TOCTOU 窗口；常规路径不可达） | 常规 review 路径不可达（`memory.js:1713`：unresolved 时 `projectFiles = []`，模型无从引用 project 条目），故架构师人工构造窗口：先经工具写入 project 两条（MEMORY.md + topic），等 review 请求已发出、回复未落地时把 `.git` 改成 `gitdir: ../nowhere` 并 `clearCache()`，再一次性提交 edit/move/remove 三条。断言 project 两文件**逐字未变**、`memory/bots/b2` 不存在、journal 三项 `(intendedOp, scope)` 恰为 `[['edit','project:unresolved'],['move','project:unresolved'],['remove','project:unresolved']]` | 该用例**未被任何 revert 删除**：我在 `27e599b` 与 `e604034` 两个头的 `memory-project.test.js` 中都搜到同一条；`27e599b` 删掉的是 team 那条。`e604034` 上单跑 **8/8** 在列 |
| 显式 `team:true` 但 Bot 无 team 写权限时落到 own | **已修复（X 定稿，`5542df2` 实现）** | `memory.js` 中 `if (op === 'add' && change.team === true && !teamWrites)`（`teamWrites = writesTeam(bot.id)`）：#52 `b6379c8` 在 `:1565`、#53 `4b6f1eb` 在 `:1613`、#54 `114a4a0` 在 `:1922`（行号随各支接线不同，判据与文案相同）→ `rt.warn(...)` + `journal({op:'skip', scope:'team', reason:'team-write-denied', after: 全文, intendedOp: op})` + `continue`，不再落 own。用例「the memory review refuses a team write the Bot may not make, instead of saving it to own」用非 Main Bot fixture，断言 own 与 team 目录均未创建、journal 带该 reason 与全文，为项目用例 8 条之一 | 与设计 §2 第 40 行「显式 own/team 仍须通过原有授权」一致。`legacy` 用例「keeps what the user said」的改写（team 条目不再进 own、journal 序列变 `add/skip/replace`）属**预期的行为变更**、非回归。历史上该点被 revert 过多次，全部线性留痕、无 force-push |


**结论：上表中「实测」的项只覆盖测试套件、静态检查，以及一次云机**加载 + 记忆基线** smoke（SMOKE-PASS）；**桌面 Electron 端的 `node:sqlite` 与 UI 截图仍未验证**，新功能 acceptance 尚未在云机上跑。不要把本文件里的测试数读成新功能验收通过——按 **X 定稿（保留 team 拒写）**，三支口径：#52 **`b6379c8`**（该支远端当前头 `26be576`，同 747、同树同一产品代码）**747**、#53 `4b6f1eb` **758**、#54 `114a4a0` **782**，均我本机 detached worktree 干净树实测，三者 `team-write-denied` 命中均为 1，**语义一致**。`4b6f1eb`/`114a4a0` 与远端 ref `2e3e9b2`/`0d8dac0` 同树（`eee4328d…`/`6d011389…`）且为祖先（`merge-base --is-ancestor` exit 0），引用哪个都不改变结论。各分支尚未合入 `dev`，合入后数字还会变。**

## 怎么自己复核

```sh
cd ds-bot
npm test        # 全量测试
npm run build   # 客户端构建（scripts/build-client.mjs）
npm run lint    # 需要 DSH_HARNESS 指向某份 deepseek-harness 的 dev/harness，否则只报「no oxlint found」
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
| 范围 | 显式 team 仍须通过原有授权（无权限不得改投 own） | `memory-project.test.js`「the memory review refuses a team write the Bot may not make, instead of saving it to own」；legacy 用例期望同步更新 | 实测（X 定稿，`5542df2` 实现） |
| 范围 | project 目标的 edit/move/remove 在 unresolved 时不改投 own | `memory-project.test.js:237`「review changes to project entries are skipped when the project breaks before they apply」——用「请求已发、回复未落」的窗口 + `clearCache()` 使该 guard 可达 | 实测（`edb6345` 8/8；X 态三支 `b6379c8`/`4b6f1eb`/`114a4a0` 的 `memory-project.test.js` 里我逐个 `git show` 核到同一条，均在） |
| 范围 | unresolved 不落 own（工具/面板/复盘三路） | `memory-project.test.js`「a session whose project cannot be told apart writes nothing by default」；`memory-acceptance.test.js`「scope: an unresolved project never falls back to own, tool or panel」 | 实测 |
| 范围 | 面板假 hash/错 session 拒绝；项目列表由服务端算 | `memory-acceptance.test.js`「scope: the panel project list is server-computed from the Bot's own sessions」、「scope: the panel writes a project entry only through a session that works in it」 | 实测 |
| 缓存 | 旧快照失效；scope 或 teamRule 变化重建 | `memory-project.test.js`「the frozen section names its scopes and shows the project memory」（断言 v2 头带排序后的 scope 集合）；`memory.test.js`「a Session keeps the memory it began with, across restarts, until its snapshot goes」「a change of role freezes the section again, so its team rule matches the tools」（快照跨重启保持、快照删除后重建、角色变化重建） | 部分实测：**已有**scope 集合进快照头、teamRule 变化重建、快照失效重建；**缺**「scope 集合变化→立即重建」与 A→B→A 的独立断言 |
| 缓存 | 普通内容仍冻结 | `memory.test.js`「a Session keeps the memory it began with, across restarts, until its snapshot goes」（写入后 `section` 逐字不变） | 实测 |
| 缓存 | 所有摘要缓存含范围；A→B→A 旧异步回包丢弃 | `memory-acceptance.test.js` 3 条 `cache:` skip（其中「old snapshots invalidate…」部分已被上面两条覆盖，但 scope 变化重建与 A→B→A 无独立断言） | skip |
| 检索 | 空查询/整 topic/全词优先/中文 1-2-3 字/转义/稳定排序/白名单在 LIMIT 前/索引失败扫描兜底 | `retrieval:` 5 条 skip 已由 `e7e82f1` 删除、改为映射注记：逐条由 `memory-index.test.js`（#53）11 例覆盖——「a long term is matched by the index and a short Chinese term falls back to a literal pass」（长词走索引、中文短词走字面）、「the scope whitelist filters before the limit」、「every word must match first, then the rows with the most words」、「quotes, percent, underscore and backslash are literals, not query syntax」、「without SQLite the same snapshot is scanned, and the answer is not empty」、「a Markdown read that fails twice is reported, never answered with an empty list」；空查询列目录与整 topic 读属既有 recall 行为，覆盖在 `memory.test.js` | 实测（映射到已存在用例，非新造断言） |
| 一致性 | move 中间态不可见；删除/归档/同 size+mtime 手改可发现；死 Bot 清理；SQLite 损坏可重建 | `consistency:` 4 条 skip 同样由 `e7e82f1` 删除并映射：`memory-index.test.js`「a file that disappears loses its rows, and an edited file is rebuilt from its hash」（删文件、按内容 hash 重建，含同 size+mtime）、「a deleted index file is rebuilt, and the same query answers again」、「a failed refresh publishes nothing and the recall still answers from the snapshot」、「cleanup drops the rows of deleted Bots and keeps team and project scopes」；move 中间态由 `memory-read-commit.test.js` 的写队列同步读断言钉住 | 实测（映射到已存在用例） |
| 验收 | idle/换段/溢出不触发；伪造完成不判成功；短确认可验 | `memory-acceptance.test.js` 3 条 `acceptance:` skip | skip（等 #54 接线后的真断言） |
| 权限 | 跨 Bot/项目锚点、`../`、同前缀、junction 拒绝；执行前重校验；secret 不外泄 | `permissions:` 3 条 skip 已由 `13154bc` 全部删除：其中 2 条转为**真断言**「permissions: evidence that exists only in another session's log is refused」「permissions: a junction inside the folder that leads outside is refused」；第 3 条（执行前重校验、固定计划不改 scope）与 secret 形态值不单独造用例，映射到 `task-review.test.js`（项目变更即丢弃候选）与 `secrets.test.js`（双道校验） | 2 条实测 + 1 条映射；**本组已无 skip** |
| 等待 | 相关 work/question 等待；其他群不阻塞；换段仍等待；`memoryReview:false` | `memory-acceptance.test.js` 3 条 `waiting:` skip | skip（等 #54） |
| 恢复 | 强杀重放；跨天 meta 不漂移；双道校验；同 ID 一次；changed:false；冲突不覆盖；`memory/full` | `memory-acceptance.test.js` 7 条 `recovery:` skip | skip（等 #54） |
| 上限 | 8 条主张、输入上限、批量预算、重试退避、新 callId 不冒充同候选 | `memory-acceptance.test.js` 2 条 `limits:` skip | skip（等 #54） |

**已删除或未建的 skip 及其去处**：身份组原先在 `memory-acceptance.test.js` 里有 10 条 skip，**全部删除**，理由是 `project-scope.test.js` 的 12 例已逐条覆盖上面「身份」那 6 行——**不重复造第二套断言**。`retrieval:` 5 条与 `consistency:` 4 条由 `e7e82f1` 删除（改成映射注记，指向 `memory-index.test.js` / `memory-read-commit.test.js` / `memory.test.js` 的既有用例），`permissions:` 3 条由 `13154bc` 删除（2 条转真断言、1 条映射到 `task-review.test.js` + `secrets.test.js`）。其余组仍是 skip，逐条列在上表，不视为通过。

**当前 skip 总数**：`memory-acceptance.test.js` 里 **18 条**（缓存 3、验收 3、等待 3、恢复 7、上限 2；`Select-String -Pattern 'test\.skip\('` 实数 18，`^test\('` 真用例 6 条）。这 18 条**一条都不算通过**。其中「检索」「一致性」「权限」三组的实质覆盖已在映射到的用例里，但**在这份文件里它们不是 skip 了，而是换成了指向既有用例的映射，不曾在 feat-55 里新增断言**——要新增断言的只剩这 18 条。

**feat-55 合并后实测（两个头，数字不同，不要混用）**
- `cb0468d`（**含** team 守卫，`memory.js` 命中 1，`memory-project.test.js` 8 例）：**806 tests / 788 pass / 0 fail / 18 skip**（exit 0），`npm run build` exit 0、`npm run lint` exit 0（仅 warning）。
- 当前头 `85f6579`（**不含** team 守卫：`d0acd7b` 又把它删掉了，`memory.js` 命中 **0**，`memory-project.test.js` 只剩 7 例）：**805 tests / 787 pass / 0 fail / 18 skip**（exit 0），同一套 `memory-acceptance.test.js` 里那条 team 断言现在固定的是「team 被拒时落会话项目」（`assert.match(... 'the ruled-in fallback: the add lands in the session project')`）。

**这是与本项目 X 定稿（保留 team 拒写）相反的状态，必须修**：合入 `b6379c8`（revert `ed06b97`）应把守卫带回、把这条断言改回 skip + journal（`team-write-denied`）。**验收判据（合完直接数）**：`git grep -c team-write-denied` 应在三个文件各命中 1 处——`src/host/memory.js`、`test/memory-project.test.js`、`test/memory.test.js`（我在 `b6379c8`/`4b6f1eb`/`114a4a0` 三支上都实测是 1/1/1），且 `memory-project.test.js` 回到 **8 例**、全量回到 **806 / 788 / 0 / 18**。在修好之前，**当前头不能作为最终验收头，也不能上云**。788 是「已实现并跑过」的部分，18 skip 是尚未转真的条目，两者不相加冒充全绿。**注意**：若在 feat-55 工作区里跑出 fail，先看 `git status`——QA 可能正在把剩下的 `acceptance:`/`waiting:` 组转成真断言，未提交状态下的失败属在写用例，不是已提交头的回归。

## 外部参考的核实方式

固定 commit `6037f8e3b91d657f5eac80ef764b41ce511499dc`：

- `jiuwenswarm/common/coding_memory_paths.py`（80 行）：`resolve_project_coding_memory_dir()` 给出 `<agent_workspace>/coding_memory/<project_name>-<path_hash>`；`resolve_coding_memory_project_name()` 在 43–67 行对规范化后的绝对路径取 sha256 前 12 位做目录后缀，文件名部分做字符清洗。→ **项目路径隔离是已实现代码，不是文档描述。**
- `jiuwenswarm/agents/harness/common/tools/task_tools.py`：任务经验写进任务数据文件。

**这不等于它的任务结果做了证据验收。** 本次没有复制任何外部代码或文本，只借鉴「以目录/仓库为项目边界、按路径 hash 分目录」这一条思路；证据验收规则是本项目自己的设计。
