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
| #52 单测与行为测试 | 实测 | `npm test` 744/744，含 A/B 项目零泄漏、worktree 同 id、子模块独立 id、unresolved 拒写、快照 scope 头、面板越权 session 拒绝 | 见 #52 分支提交说明 |
| #53 接线后全量测试 | 实测 | `npm test` 755/755；`build-client --check` 退出 0；`npm run lint` 退出 0 | 见 `feat/53-memory-index` 的 `2943fc2` |
| `node:sqlite` + FTS5 trigram 在 Node 侧可用 | 实测 | 设计 §8 记录的探针：建表、长中文 MATCH、短中文 LIKE、scope 过滤均通过 | 只覆盖 Node/Web 侧 |
| **桌面 Electron 端的 `node:sqlite`** | **未验证** | 无 | 本机无 DSH 的 `app/` checkout，跑不了探针；桌面端必须走扫描回退 |
| 原生 Windows 隔离 smoke | **未验证** | 无 | `dev/bench.sh` 需要 `deepseek-harness` checkout 与本机不符，尚未跑；不得计为通过 |
| 面板 UI 截图 | **未验证** | 无 | 依赖 UI 构建与真实界面，尚未截图 |
| 同大小同 mtime 的手工改写可被发现 | 推断 | 设计 §4 规定以内容 hash 为唯一新鲜度依据，不用 mtime/size | 待 #53 用例实测 |
| 归档后清理死 scope 的索引行 | 推断 | #53 实现里有显式回收，见 `memory-index.js` 与归档调用点 | 待用例实测 |
| 强杀后逐项续写、每条恰好一次 | 推断 | 设计 §6 的逐项状态机与固定 `review_id` | 待 #54 故障注入实测 |
| 项目无法判定时不落 own（工具路径） | 实测 | #52 的 `memory-project.test.js`：unresolved 拒绝隐式写入 | 见 #52 分支 |
| 项目无法判定时不落 own（自动复盘路径） | **待修复** | 审查发现 `applyReview` 在 `projectOf().status !== 'ok'` 时落 `ownScope(bot.id)`，unresolved 也会走到这里，与设计 §2 不符 | 架构师在 #52 修：skip + journal，补 broken gitdir 回归；修复前不得合并 PR #57 |

**结论：上表中「实测」的项只覆盖测试套件与静态检查；新功能的隔离 smoke、UI 截图、桌面端探针都还没有跑。不要把本文件的 755/755 读成新功能验收通过。**

## 怎么自己复核

```sh
cd ds-bot
npm test                      # 全量测试
npm run build-client --check  # 客户端构建检查
npm run lint
```

测试全部写在临时目录（`.dsh-test-*`）里，用 `dev/mock-llm.mjs` 当模型，不需要任何密钥，也不会碰 `~/.dsh`。

## 外部参考的核实方式

固定 commit `6037f8e3b91d657f5eac80ef764b41ce511499dc`：

- `jiuwenswarm/common/coding_memory_paths.py`（80 行）：`resolve_project_coding_memory_dir()` 给出 `<agent_workspace>/coding_memory/<project_name>-<path_hash>`；`resolve_coding_memory_project_name()` 在 43–67 行对规范化后的绝对路径取 sha256 前 12 位做目录后缀，文件名部分做字符清洗。→ **项目路径隔离是已实现代码，不是文档描述。**
- `jiuwenswarm/agents/harness/common/tools/task_tools.py`：任务经验写进任务数据文件。

**这不等于它的任务结果做了证据验收。** 本次没有复制任何外部代码或文本，只借鉴「以目录/仓库为项目边界、按路径 hash 分目录」这一条思路；证据验收规则是本项目自己的设计。
