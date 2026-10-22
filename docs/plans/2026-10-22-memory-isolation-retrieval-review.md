# 记忆：项目隔离、本地全文检索、任务复盘

- 日期：2026-10-22；修订 11（最终一致性审查）。
- 基线：`dev @ ba9757b`，含 PR #48/#49/#50。
- 状态：**设计审查通过，可进入实现；功能尚未实现，新功能验收尚未执行。**
- 范围：仅设计文档。未合并、未部署、未重启服务、未迁移真实记忆。
- 相关：`2026-10-09-context-and-memory.md`、`2026-10-16-bot-handoffs.md`。

## 目标与边界

补上项目记忆隔离、本地全文检索、任务结束后的经验复盘。继续使用 Markdown 作为记忆正文，SQLite 只存可重建索引；复用现有写队列和记忆提交接口。

**不引入向量、embedding、向量数据库或相关服务，不预留这些接口和配置。** 检索只承诺词面匹配，不能保证同义改写召回。避免新建任务管理平台、通用事务系统和后台定时整理系统。

## 1. 项目身份与作用域（R1）

`resolve(cwd)` 返回 `ok {hash, root, kind}`、`none` 或 `unresolved {reason}`。读、写、提示词和面板共用此解析器。

1. 用 `realpathSync.native` 规范化 cwd 和最终身份路径，保留真实大小写。长路径前缀如需规范化，必须区分盘符路径与 UNC，保证指向同一对象；不直接盲删前缀。
2. 从 cwd 向盘根寻找最近的 `.git`，**先完成 Git 搜索，再考虑项目标记物**。Git 搜索不在 teamFolder 提前停止：从 `ds-bot/` 启动也必须找到父目录 `deepseek-bot/.git`。
3. `.git` 为目录时取其真实路径；为文件时解析 `gitdir:`，支持绝对路径及相对该文件目录的路径。再解析 gitdir 下可选的 `commondir`（相对 gitdir，或绝对路径）；没有则用 gitdir 本身。格式错误、不可读或断链返回 unresolved，不当作不存在。
4. Git 身份为实际 common dir。同仓库 worktree 共享身份；普通 submodule 的 common dir 为父仓库 `.git/modules/<name>`，与父仓库 `.git` 不同，**作为独立项目**。不得从目录名猜父仓库。
5. 没找到 Git 才从 cwd 向上找最近的 `package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` 或 `*.csproj`。若 teamFolder 是 cwd 的祖先，包含 teamFolder 后停止；否则到盘根。不设任意层数上限。
6. 均无标记时，cwd 等于 teamFolder 则 none（分组目录）；否则以 cwd 自身作为项目根。`cwd === teamFolder` 不能跳过前面的 Git/标记搜索。
7. `hash = sha256(规范化身份路径)` 前 16 位小写 hex；scope 为 `project:<hash>`，目录名只用 hash。`projects.json` 保存身份路径用于显示和碰撞核验；同 hash 不同路径必须拒绝合并并报错。

解析缓存最长 10 秒，包含 ok/none/unresolved；工作目录变化和换段时失效。每次读写都由同一解析器取当前结果，短暂失败不能永久冻结。同步 context hook 使用已有 agent/session 的公开同步属性，**所有消费者一律通过 `rt.sessionFolder(session)` 取得 cwd**（优先 workingDirectory，回落 header.cwd），不能另起直接读 header.cwd 的算法；不调用异步接口或读取 DSH 私有内部状态。

项目搬动或身份路径重命名产生新 hash。可提示旧路径，由用户明确选择后另行迁移；本期不自动合并或复制。

## 2. 可见性、写入与缓存（R2/R6）

| 范围 | 读取 | 写入 |
|---|---|---|
| own | 本 Bot；保留既有 Main Bot 明确授权的跨 Bot 行为 | 本 Bot；保留既有授权规则 |
| team | 团队 Bot | Main Bot、群管理员，沿用现有权限 |
| project | 当前会话解析出的项目 | 当前会话解析出的项目 |

- 默认读取：有项目为 own + project + team；none/unresolved 为 own + team。
- 默认写入：有项目为 project，none 沿用 own；unresolved 拒绝隐式写入并解释原因。显式 own/team 仍须通过原有授权。
- Main Bot 权限不自动扩大到其他项目。模型工具只选逻辑 scope，不接受任意项目 hash。
- `projectMemory` 默认 true；false 时项目读取和写入均关闭、范围缓存失效。已有项目会话的隐式写入明确拒绝，不自动把项目内容转存全局；用户仍可显式选择经授权的 own/team。
- 所有入口共用 `writeScopeOf(session, requested)` 与 `readScopes(session)`。覆盖 remember/forget/move、自动 review、面板摘要/问答/更新/删除；删除 Bot 只归档 own。
- 现有硬编码 own/team 五处必须一起接线：`memorySection:816`、`memoryView:1218`、`memoryAsk:1250`、`applyReview:1417`、`reviewSession:1527`（行号均指基线 memory.js）。

提示词冻结快照增加版本、排序后的 scope 集合，继续校验原有 teamRule。旧版本或范围/角色变化必须重建；普通记忆内容变化保持原有冻结策略，依靠 recall 获取新增内容。

面板 summaries/summarizing/summaryFailures 全部以 Bot + scopeSet 为键，磁盘缓存也带版本和 scopeSet。异步响应必须同时匹配当前请求编号、Bot、会话、scopeSet；项目切换或 A→B→A 后的旧结果不得覆盖新结果。

面板的项目列表由服务端根据该 Bot 的有效会话生成。请求携带选中的 sessionId 和项目标识，服务端重新核对会话归属、当前解析结果、目录存在、配置开关及原有调用者权限。更新前再次检查；失效就拒绝，不静默转写 own。

**隔离是插件记忆 API 的范围边界，不是文件系统沙箱。** 文件工具能力不因此收窄；历史 own/team 中的项目内容不自动隔离，显式共享也不保证语义隔离。

## 3. 存储与最小模块划分

默认记忆根为 `<DSH_HOME>/bot/memory`；`config.home` 替换的是 botHome，实际根始终为 `<botHome>/memory`（index.js:52、memory.js:504）。

```text
<botHome>/memory/
  bots/<botId>/MEMORY.md + <topic>.md     现有正文
  team/MEMORY.md + <topic>.md             现有正文
  projects/<hash>/MEMORY.md + <topic>.md  新增正文
  journal.jsonl                           现有审计，非恢复依据
  snapshots/                             现有冻结快照，增加版本和范围
  reviewed.json / rejections.json         现有
  projects.json                           项目身份路径及显示信息
  index.sqlite                            唯一检索派生状态，可删除重建
  task-plans/<candidateId>.json           从入队起保存候选、计划和进度
  task-plans/corrupt/                     隔离损坏记录，保留证据
```

不另设 task-candidates.json、index-dirty.json、index-hashes.json。候选和提取计划用**同一个逐候选文件**，避免两份队列状态的提交窗口。

| 新模块 | 职责 |
|---|---|
| project-scope.js | 身份解析、范围计算、缓存、项目显示目录 |
| memory-index.js | 内容 hash、索引刷新与检索、降级 |
| task-review.js | 候选持久化、证据核验、固定计划、逐项恢复 |

memory.js 负责接线并注入私有闭包中的能力：`read/list` 的 committed 读取器、`runInMemoryQueue(fn)`、现有 add/replace/remove/commit 接口、作用域解析、公开会话/事件访问、模型调用及配置。模块不得自行寻找 writing 变量，也不得嵌套等待同一写队列造成死锁。

## 4. 本地全文检索与一致性（R3/R7）

索引使用 SQLite FTS5 trigram；正文与 topic 检索字段覆盖现有匹配语义，附带 scope、相对文件路径、行号、added 等元数据。普通 files 表以 `(scope,file)` 为主键保存已提交内容的 sha256。元数据列不参与全文匹配。

每次 recall：

1. **把采集任务本身放入现有写队列**，而非仅 `await writing` 后在队列外读取。队列项内同步完成允许 scope 的文件枚举、committed 读取和 hash 计算；采集期间无 await。
2. 同步比较允许范围内完整文件集合：新增/变化文件删旧行重建；消失文件删全部旧行。索引刷新在一个 SQLite 事务内提交。
3. 使用同一份不可变采集内容，串行完成本次索引刷新和查询；同一连接的其他刷新不能插入其间。扫描降级也使用此快照，不再读第二次盘。
4. SQLite 不可用、锁冲突、损坏、版本不符或事务失败：记录可诊断告警并扫描本次 Markdown。可重建索引下次重试；运行时缺 node:sqlite 则本进程保持扫描模式，避免每次重复导入和告警。
5. Markdown 也读不出来就明确报错，不伪装成「没有记忆」。正常确实没有匹配时允许空结果。

这一边界覆盖 queued moveEntry 的两步写入（memory.js:767/771）、归档 rename（:800）和下次检索前的外部手工改写。同大小同 mtime 的改写也由 hash 发现。**外部编辑器不受插件队列约束，不承诺多文件外部并发编辑的原子快照**；文件在扫描中消失/读错可重试一次，仍失败就报告。

归档后的 Bot scope 不再进入白名单，需额外回收不可达索引：**启动时以及归档成功后**按当前有效 Bot 集合事务清理已删除 Bot 的 entries/files 行。清理失败不扩大可见性，下次启动再清理。不借 journal 失效钩子维持新鲜度。

查询规则：

- 沿用现有查询长度/词数/结果数量上限。空查询保留目录式列举；topic 保留整份读取和原 scope 优先级。
- 先查含全部词的条目，没有才按匹配词数返回部分命中；同时覆盖 topic 名的匹配。短长词混合时也必须满足这条语义。
- ≥3 字符词走转义后的 FTS 短语，1–2 字符走字面量 LIKE；引号、`%`、`_`、反斜杠分别正确转义，参数化查询。
- scope 白名单过滤在 LIMIT **之前**；不能先取全库前 N 再过滤。
- 同一匹配档内按 BM25，再 own/project/team、added、scope/file/line 稳定排序；扫描降级保留全部词优先和稳定顺序，但不承诺与 BM25 完全相同排名。

现有 recall 已读取可见 Markdown；新设计仍为 O(可见正文)，增加 hash 与索引维护，不声称减少磁盘读取或保证特定延迟。索引只负责本地检索排序和组织。

## 5. 任务验收与证据（R5）

回合 idle 仅是唤醒时机；换段、压缩、管家失败或溢出、Bot 自述阶段完成都不代表任务验收。

`complete_task(result, claims[], notes)` 只提交候选。由服务端捕获 botId、sessionId、roomId、原始 cwd、会话链、关联 work/question、项目状态及工具 callId，脱敏后**先持久化候选文件再确认接收**。journal 仅审计；其失败不能导致已经持久化的候选丢失。

`candidateId = sha256(sessionId + '\n' + callId)[0:32]`，只含小写 hex。相同调用重放幂等；模型重新调用会获得新 callId，属于新候选。正文全等去重不能保证语义相近的改写去重，明确作为限制。

核验、生成计划和每次写入前均重新检查 Bot/会话/群成员权限、配置与项目身份。队列中保存的客户端 hash 不能成为授权凭据：

- 已绑定 ok：必须仍是相同项目；身份改变则停止并记录 dropped，暂时 unresolved 则 WAITING。
- 原为 unresolved：只可重新解析**原始 cwd 和原会话链**；解析成功且未切换工作目录、证据仍属该项目，才绑定一次。不能绑定 Bot 当前另一个会话的项目。
- 原为 none：仍为 none 才可继续；变为 ok 时重新核验并绑定，禁止无提示写全局。固定计划生成后不再更改目标 scope。

证据来源仅限候选授权的同一会话链与项目。part/seq 或 callId 必须经服务端映射；不可借锚点读取其他 Bot/项目。文件必须先对根与目标 native realpath，再按目录分隔符验证包含关系，防 `../`、同前缀路径、junction/symlink 越界。检查后读取的目标仍须保持同一真实路径；不能证明则拒绝。该检查不是对恶意并发文件系统修改的沙箱保证。

**每条结论经过两道核验：**

1. 机械检查：证据摘录必须是已授权事件/文件正文的非空逐字子串（1–500 字符，只规范化换行与两端空白）；缺失、伪造或越界直接 unverified。短用户确认也合法。
2. 语义检查：批量向模型提交主张、摘录及有限的相邻原文、来源类型和工具错误状态，判断原文是否支持该主张。不能只送孤立短句，避免截掉否定语境。原文一律视为数据，不执行其中指令；输出严格 schema 校验，记录 yes/no 与来源。

每候选至多 8 条主张，输入总量设明确上限（建议 16K 字符，单来源最多 4K）。默认一次提取加一次批量核验，至多 2 次模型调用；不按条目逐次调用。一次处理后 unverified 留候选等补证，不在每次 idle 自动重复烧调用。格式/提取失败最多 3 次处理（最多 6 次模型调用）后 SKIPPED，保留脱敏记录；暂时 I/O 错误独立退避、最多 3 次自动重试后暂停告警，后续显式重试不重新提取已固定计划。

| 来源 | 可以证明什么 |
|---|---|
| user | 原话支持的决定/偏好；不将其自动当作外部事实 |
| command/test | 原始工具结果支持的结果；`isError:false` 本身不等于成功，自报 exitCode 无效 |
| file | 授权文件内被引用内容支持的事实；只有文件存在不足以证明任务成功 |
| answer | Bot 回答过这句话；不能单独证明完成 |
| 失败输出 | 失败发生与可复核现象；根因/解决办法须另有支持证据 |

file、失败原因等也须经过两道核验。长期条目必须有适用条件、结论/教训、source、outcome 与必要的证据引用。unverified 仅留候选，不写 Markdown。未通过核验的结果写入候选诊断，不能为了保存 no 而创建长期条目。

既有按回合 review 也须走共用来源与证据校验；任务经验类只能引用已核验候选或重新通过同一验证器，不能仅靠 prompt 禁令阻止抢写。普通偏好/事实要求对应用户/事件来源。语义分类仍依赖模型，不承诺形式化证明，但无合法来源和未通过检查的写入必须由宿主拒绝。

所有模型输入、候选、计划、notes、evidence、meta、journal 和最终条目在持久化/发送前进行现有 secret 检查和脱敏。无法安全保留的条目拒绝，诊断仅写 ID 与非敏感原因，不能把全文密钥写进 skip 日志。机械原文验证可在内存中进行，原始秘密不落盘；脱敏后丢失关键证据则保持 unverified。最终格式行仍受现有条目/文件大小上限约束，超限缩减非必要摘录或拒绝，不无限重试。

## 6. 等待、持久化与逐项恢复（R4）

`memoryReview:false` 同时关闭任务复盘，不新增第二个开关。关闭时停止新入队/处理，保留未完成记录，恢复配置后重校验再继续。

状态：PENDING → WAITING / RETRY / SKIPPED / PLANNED → APPLYING → DONE；另有 DROPPED、CONFLICT、CORRUPT、CAPACITY。记录文件包含版本、候选绑定、状态、重试次数、可选不可变 plan、逐项 progress。所有更新通过一个串行执行器 temp+rename。

`error.code === 'memory/full'` 单列 CAPACITY，不自动重试、不占语义失败额度，保留记录并提示整理容量；容量释放后可显式恢复，已完成项仍跳过。不得靠错误文案分类。

WAITING 只检查该候选关联 work、同一会话链的待答问题；不得用「Bot 任意任务未回」阻塞其他群聊。现有 waitsWork 接受 workId，不能传 botId；如需新查询辅助函数，按 candidate 的关联 workId 集合查询。问题换段迁移后按 questionId 追踪到新 Session。子任务交回、问题回答、换段结束及该链下一次 idle 唤醒，启动扫描逐候选文件恢复，不读取无限增长的 journal 重建队列。

计划生成后 items 固定（scope、topic、text、完整 metadata/line）；恢复不重新调用模型。source/by/kind/added/outcome/evidence 全部冻结，由**同一个 `formatEntry(text, meta)`** 生成期望行，apply 原样传入 meta，**不得重新调用 metaFor 或重算日期**，防 project 的 by 和跨天 added 发生漂移。每项 entryId 由 candidateId + index 确定，**以全小写保留元数据 `review_id` 写入最终 Markdown 条目**（现有 splitMeta 会把键转小写），解析/格式化必须往返保留。下文 reviewId 指该字段的值，它不由模型填写。

现有 addNow 自身不执行全部长度/秘密检查；接线必须在**计划落盘前和每次 apply 前**显式调用 entryProblem/secretEntry（包括完整 metadata），不依赖工具入口已经检查过。计划 schema、固定范围与格式也须复验，手改污染的计划不得直接落库。

逐项提交必须通过同一记忆写队列，顺序如下：

1. DONE 项永远跳过，避免用户后来删掉的条目在重启后复活。
2. 扫描该 scope：已有同 reviewId 且最终行一致，检查必要 topic 链接，缺链接则补；完整后记录 done。
3. 同 reviewId 但内容/元数据与计划不符：CONFLICT，保留并告警，禁止自动 replace 用户修改。
4. 尚无该 ID，但现有 addNow 整 scope 全等去重命中：`changed:false` 即 deduplicated done，记录返回的实际 file；不追写目标 topic，不覆盖原条目来源/元数据，不声称原条目因此获得新验证。
5. 无现存匹配：写入前在 progress 持久化本次目标文件及必要 MEMORY.md 的内容 hash，再提交固定行及链接。成功后记录 done。恢复遇到没有 reviewId、但目标与持久化前置 hash 不同且不能用第 2–4 步解释的情况，暂停为 CONFLICT；不猜测是用户编辑还是中断。

没有 ID 的同文去重命中只代表已有正文；若其必要链接缺失，可补链接后再完成。补链或提交失败不得提前记 done。topic 与 MEMORY.md 跨文件中断后，以固定 ID/行/链接逐项核验和补全；不承诺跨文件断电原子性。

损坏记录保留在 corrupt 下，并为 candidateId 保存隔离标记；扫描和调用重放都不得悄悄生成新计划覆盖它。若隔离本身失败，原地保留并报告，停止该候选。解析失败不能永久 skip，也不能直接删除。已成功落盘的其他候选继续处理。

此协议覆盖进程强杀后可读取文件的逐项恢复；不承诺断电、磁盘损坏或外部并发修改下的全局事务。计划自身损坏需要人工处理。journal 不提供不存在的持久恢复能力，现有 commit 的 catch 回滚也不能被说成强杀回滚。

## 7. 实现验收清单（尚未执行）

| 组 | 必须覆盖的情形与断言 |
|---|---|
| 身份 | 仓库根等于 teamFolder 仍为项目；ds-bot 子目录找到父 Git；monorepo 标记不覆盖 Git；worktree 同 ID；普通 submodule 不同 ID；绝对/相对 gitdir 与 commondir；无 Git 深层目录不被层数切开；none/unresolved 后补 Git 能恢复；真实大小写与 UNC；hash 碰撞拒绝 |
| 范围 | A 写 B 零可见；所有第一方入口默认 project；unresolved 不落 own；Main Bot 不跨项目；panel 假 hash/错 session/配置关闭拒绝；API 隔离边界明确 |
| 缓存 | 旧快照失效；scope 或 teamRule 变化重建；普通内容仍冻结；所有摘要缓存含范围；A→B→A 旧异步回包丢弃 |
| 检索 | 空查询、整 topic、全词优先再部分、中文 1/2/3 字及混合查询、topic 名、转义字面量、稳定排序、白名单在 LIMIT 前；匹配 fixture 在索引失败后仍由扫描找到，真正无匹配可空；双重读取失败明确报错 |
| 一致性 | move 两步之间排队 recall 不采中间态；删除/归档/同 size+mtime 手改可发现；清理死 Bot 的 entries/files；SQLite 删除/损坏可重建；事务失败不发布部分索引 |
| 验收 | idle/换段/溢出不触发；伪造完成、自报退出码、工具包装成功但测试失败均不判成功；短用户确认可验；伪造摘录拒绝；否定上下文不截断；file/根因同样核验；模型输出无来源由宿主拒绝 |
| 权限 | 跨 Bot/项目锚点、../、同前缀目录、junction/symlink 拒绝；成员变化与执行前范围重校验；unresolved 只恢复原 cwd；固定计划不改 scope；secret 出现在任何字段均不泄漏 |
| 等待 | 相关 work/question 未完等待；其他群的问题不阻塞；问题换段仍等待；启动恢复未生成计划的候选；memoryReview:false 不执行；无补证不循环调用模型 |
| 恢复 | 候选落盘后返回前强杀可重放；固定计划后不再提取；跨天重启 meta/by/added 完全不漂移；计划与 apply 双道长度/秘密校验；每个正文/链接/进度写入前后强杀；同 ID 不重复；其他 topic 全等条目 changed:false 能结束；done 后用户删除不复活；人工冲突不覆盖；损坏隔离且其他候选继续；memory/full 暂停且不耗重试额度 |
| 上限 | 8 条主张、输入上限、批量调用预算、格式重试和 I/O 退避上限；最终条目/文件大小；重复模型调用新 callId 不冒充同候选 |

实现测试使用临时目录和故障注入，禁止操作真实 `.dsh`。通过后再按仓库规范提 PR、审查、合并、更新插件和清理 worktree；这些不属于本次设计交付。

## 8. 审查记录与证据

DSH 团队进行了分工复审：架构师 R1/R2、插件工程师 R3/R4、测试工程师 R5/R6/R7，Chief 汇总。最后由 Codex 对源码和修订稿独立核对并收口；不以团队一句「通过」代替文档检查。

| 问题 | 最终处置 |
|---|---|
| R1 项目身份 | 撤回子模块共用父身份及任意 3 层限制；Git 优先、真实 common dir、缓存可恢复 |
| R2 冻结/摘要串项目 | 版本 + scope + 原有角色校验；请求编号防异步旧结果 |
| R3 写入旁路与刷新窗口 | 在写队列内同步采集；一个索引派生状态；完整集合比对；死 scope 清理 |
| R4 强杀/去重循环 | 候选与计划同文件；固定 reviewId；changed:false 终结；不重做提取；冲突停止 |
| R5 无证据经验与等待 | 来源权限、批量双重核验、原 review 共用验证、关联等待、预算和脱敏 |
| R6 接口范围 | 服务端会话推导并复验；声明 API 不是文件系统沙箱 |
| R7 检索退化 | 短词回退、全词优先、字面量转义、scope 先过滤、真实错误可见 |

独立验证（本轮实际执行）：

- Windows Node v24.20.0 / SQLite 3.53.4：FTS5 trigram 建表、长中文 MATCH、短中文 LIKE、scope 过滤通过；native realpath 大小写归一探针通过。
- 原生 Git 子模块探针：sub/.git 为 `gitdir: ../.git/modules/sub`；gitdir 无 commondir；父与子 git-common-dir 不同。参考 [Git submodules](https://git-scm.com/docs/gitsubmodules)、[repository layout](https://git-scm.com/docs/gitrepository-layout)。
- 隔离文档 worktree 的**既有代码基线**：npm test **727/727**；build-client --check 通过；lint 退出 0，14 条既有 warning。日志和探针摘要位于 `D:/Temp/2026-10-22-ds-bot-memory-design/`。
- 以上由 Codex 执行、团队核对，**不能当作新功能验收通过**。桌面 Electron、大小写敏感目录和新恢复故障注入未验证；运行时探测失败须扫描回退，桌面未知不阻止 Web 设计。

外部参考固定为 JiuwenSwarm commit `6037f8e3b91d657f5eac80ef764b41ce511499dc`：[coding_memory_paths.py](https://github.com/openJiuwen-ai/jiuwenswarm/blob/6037f8e3b91d657f5eac80ef764b41ce511499dc/jiuwenswarm/common/coding_memory_paths.py) 已有项目路径隔离；[task_tools.py](https://github.com/openJiuwen-ai/jiuwenswarm/blob/6037f8e3b91d657f5eac80ef764b41ce511499dc/jiuwenswarm/agents/harness/common/tools/task_tools.py) 的 experience_learn 会写 task-data.json。撤回早先「对方没有实现」的断言；这些事实不证明其具有本稿的证据验收规则。本次未引入外部实现代码。

修订 1–10 的讨论与撤回记录保留在此分支 Git 历史。修订 11 合并重复条款，移除互相矛盾的验收行，纠正候选落盘窗口、仅等待队列尾部的竞争、恢复 ID 缺失、覆盖用户修改以及模型调用成本表述。当前各节是唯一有效设计，不再沿用历史稿中的替代方案。
