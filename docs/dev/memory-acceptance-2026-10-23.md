# 记忆系统交付验收（2026-10-23）

本记录替代 [10 月 22 日的阶段记录](memory-verification.md) 作为 #51–#55 的当前交付入口；[冻结设计](../plans/2026-10-22-memory-isolation-retrieval-review.md) 的功能与权限约定不变。

## 候选与结果

- 集成候选：`dev @ 5a30c65d647b9a2be65c8b28ecc8022318752d9a`，已合并 [PR #100](https://github.com/leinasi2014/DeepSeek-Bot/pull/100)。这是开发分支交付，不是 `main`/npm 发布。
- 本轮 Web、故障注入及 Electron 运行时验证使用产品基线 `e518ca4770b465576da0b0d5159cb9c0f0103840`。它到集成候选仅新增 `task-review-restart.test.js`，产品文件未变；可复用这些证据。
- 本机完整测试：**930 总数，912 通过、0 失败、18 跳过**；客户端生成检查与 lint 均退出 0。[CI run 39947414811](https://github.com/leinasi2014/DeepSeek-Bot/actions/runs/39947414811) 的 7 个检查通过。
- 18 个 `memory-acceptance.test.js` 历史占位仍为 skip，**不计通过**。下表指向实际执行测试，不以占位标题代替覆盖，也不声称每个设计情形都已全平台验证。
- 正文保留 Markdown；SQLite 是可重建索引。检索为词面检索，**无向量、embedding 或向量服务**。

## 设计 §7 的十组映射

路径均为仓库内测试；本轮全量结果覆盖这些可执行用例。表内概述其关键行为，环境与证据层级限制见后文。

| 组 | 实际覆盖与入口 |
|---|---|
| 身份 | Git 优先、worktree 共用身份、submodule 分离、gitdir、深层标记、缓存失效、碰撞拒绝：[project-scope.test.js](../../ds-bot/test/project-scope.test.js)。Windows 特殊目录/真实 UNC 未验。 |
| 范围 | 默认项目写入、跨项目不可见、unresolved 拒写、面板会话校验：[memory-project.test.js](../../ds-bot/test/memory-project.test.js)、[memory-acceptance.test.js](../../ds-bot/test/memory-acceptance.test.js)。 |
| 缓存 | 会话快照、角色/团队规则变化与摘要范围：[memory.test.js](../../ds-bot/test/memory.test.js)、[memory-acceptance.test.js](../../ds-bot/test/memory-acceptance.test.js)；项目切换显示：[memory-panel-render.test.js](../../ds-bot/test/memory-panel-render.test.js)。 |
| 检索 | 短中文、字面转义、全词优先、scope 白名单先于 LIMIT、索引失败扫描回退、读取失败报错：[memory-index.test.js](../../ds-bot/test/memory-index.test.js)。 |
| 一致性 | 内容 hash 刷新、删除与死 Bot 清理、索引重建/事务失败：[memory-index.test.js](../../ds-bot/test/memory-index.test.js)；队列与提交可见性：[memory-read-commit.test.js](../../ds-bot/test/memory-read-commit.test.js)、[memory-files.test.js](../../ds-bot/test/memory-files.test.js)。 |
| 验收 | 实际工具来源、失败结果、禁止事项与逐条经验的语义核验：[memory-source-evidence.test.js](../../ds-bot/test/memory-source-evidence.test.js)；显式报告与来源接线：[task-review-wiring.test.js](../../ds-bot/test/task-review-wiring.test.js)。 |
| 权限 | 文件锚点、目录越界、junction 与跨会话来源：[task-review-wiring.test.js](../../ds-bot/test/task-review-wiring.test.js)、[memory-acceptance.test.js](../../ds-bot/test/memory-acceptance.test.js)；执行前身份/项目复验：[task-review-project-binding.test.js](../../ds-bot/test/task-review-project-binding.test.js)；秘密检查：[task-review-apply-check.test.js](../../ds-bot/test/task-review-apply-check.test.js)。 |
| 等待 | 关联 work/question、换段和群轮次：[task-review-waiting.test.js](../../ds-bot/test/task-review-waiting.test.js)、[task-review-wiring-real.test.js](../../ds-bot/test/task-review-wiring-real.test.js)、[task-review-group-book.test.js](../../ds-bot/test/task-review-group-book.test.js)；开关：[memory-review-off.test.js](../../ds-bot/test/memory-review-off.test.js)。 |
| 恢复 | 固定计划、去重、删除不复活、冲突/损坏/容量停顿：[task-review.test.js](../../ds-bot/test/task-review.test.js)；跨日真实进程恢复：[task-review-restart.test.js](../../ds-bot/test/task-review-restart.test.js)；双道检查及自动唤醒：[task-review-apply-check.test.js](../../ds-bot/test/task-review-apply-check.test.js)、[task-review-autowake.test.js](../../ds-bot/test/task-review-autowake.test.js)。 |
| 上限 | 序列化输入/来源预算、主张上限、批量调用：[task-review-input.test.js](../../ds-bot/test/task-review-input.test.js)、[task-review-budget.test.js](../../ds-bot/test/task-review-budget.test.js)；格式重试、I/O 退避与候选 ID：[task-review.test.js](../../ds-bot/test/task-review.test.js)。 |

## 实际交互与恢复证据

| 验证层级 | 本轮结果与含义 |
|---|---|
| 真实 Web 面板，隔离 mock 环境 | **7 格 PASS**：项目修改、own 修改、team 新增、team 修改、刷新保留三个作用域、项目删除、team 删除。修改前核对可见编号；修改后分别断言响应、磁盘正文、journal 操作及其他作用域未变，保留截图。 |
| 真实队列 + 进程强杀 | **4/4**：正文写入前终止后继续；该窗口人工修改正文/索引各自进入 CONFLICT 且保留原字节；正文和链接落盘但 done 未保存时恢复且不重复。每例父进程发 SIGKILL，独立新进程读取同一隔离目录；原进程均已退出。 |
| 跨日、跨进程固定计划（PR #100） | **2/2**：计划落盘、正文落盘但链接未完成两个窗口强杀；换日期并改 Bot 名后启动新 host，`source/by/kind/added/outcome/evidence` 与冻结行一致、零额外提取/核验，再第三个 host 重启验证幂等。重算日期/作者的负对照均在对应断言失败。 |
| 既有基础 smoke | `ec00c63` 上 **41/41**，覆盖加载、Bot/群、换段、handoff、文件夹/权限、能力挂载等。`index.js`、memory-files/index、project-scope、parts 与当前相同；memory.js 的面板提示/拒绝计数及 task-review 的拒绝保留变更由新版聚焦回归与本轮 UI 补验。限这些既有基础流程复用，未声称本轮重跑。 |
| Windows 云机 Electron 运行时 | 实际安装的 `DeepSeek Harness.exe` 以 `ELECTRON_RUN_AS_NODE=1` 运行：Electron **44.7.0**、Node **24.21.0**、SQLite **3.53.4**；真实 `memory-index.js` 的 scope/短中文/刷新/回退/重开等 **9/9**。这是运行时兼容性验证，**不是桌面 GUI 验收**。 |
| 本机部署 | 交付负责人于 **19:38（UTC+08:00）** 重启后台 Web 服务，官方插件列表确认加载链接安装；后台 Web/中转任务均运行，**9 个 Bot、2 个群组**的 ID 保持一致。外网 token 登录返回 **303**，匿名 API **401**、认证 state 成功；未把生产数据用于功能测试。 |

完整命令、候选/文件哈希、原始输出、故障注入脚本及截图已隔离归档；包含本机环境信息的日志不进入仓库。仓库可访问入口为上方 PR/CI，跨日测试可直接复跑：

```sh
cd ds-bot
node --experimental-test-module-mocks --import ./test/harness-resolve.mjs --test test/task-review-restart.test.js
```

依赖按仓库说明安装，或设置 `DSH_HARNESS`；测试只创建临时夹具，不指向用户 DSH 数据。

## 边界与未验证项

- **Windows 大小写敏感目录、真实 UNC 网络路径、完整桌面 GUI 尚未验证。** 普通 Windows 路径测试与 Electron SQLite 探针不能替代它们。
- API 校验隔离记忆作用域，**不是文件系统沙箱**；持有其他文件工具权限的智能体仍受那些工具自身的访问控制约束。
- 强杀证据覆盖上述确定窗口，不宣称遍历了每一个文件系统中断点；不承诺断电、磁盘损坏或多个独立 host 并发写同一数据根的全局事务。
- 语义核验使用模拟模型验证接线与拒绝路径；不证明任意真实模型判断都正确。历史失败保留在旧记录中，不覆盖当前候选的结果。
