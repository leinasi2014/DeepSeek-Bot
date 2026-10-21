// The ruler for the memory work (issues #4 and #12): four scenarios on a running bench with
// a real model, three rounds each, every round reported. Judged mechanically — journal ops,
// capacity, the review cursor, and whether remember/recall was called. Semantic correctness
// (did a fact keep its meaning, did a method land in a topic) is printed as a five-item
// manual spot-check, never folded into a pass/fail. Nothing here touches the real memory or
// the real Bot team: it runs against a bench home and a copy of MEMORY.md.
//
//   node dev/bench-memory.mjs <bench-home> <web-port> <model-ref> [options]
//     --tap <llm-tap.jsonl>   the tap log, for model calls and tool names (required)
//     --team-source <file>    the team MEMORY.md to copy in for scenario 1
//     --rounds <n>            rounds per scenario (default 3)
//     --only <a1,a2,a3,a4>    run a subset (default all)
//     --out <report.json>
// Every file this script reads or writes is UTF-8 explicitly, and every path is built
// with join(): the scenarios are Chinese text and the bench also runs on Windows, where a
// console redirected to a file keeps the bytes but the console itself may not be UTF-8
// (`chcp 65001`, or write to a file and read it back as UTF-8).
//
// Costs real tokens. One round is roughly 40-60 calls; three rounds stay under 200.
// Every scenario reports its own stop line and passes only when all rounds pass; the
// numbers of each round are printed even when an earlier round failed.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { parseArgs } from 'node:util'
import { a2Pass, a2bOutcome, a2bSummary, cursorProgress } from './bench-rules.mjs'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tap: { type: 'string' },
    'team-source': { type: 'string' },
    rounds: { type: 'string', default: '3' },
    gap: { type: 'string', default: '5000' },
    only: { type: 'string' },
    out: { type: 'string' },
  },
})
const [HOME, PORT, MODEL] = positionals
if (!HOME || !PORT || !MODEL || !args.tap) {
  console.error('usage: node dev/bench-memory.mjs <bench-home> <web-port> <model-ref> --tap <llm-tap.jsonl> [--team-source f] [--rounds 3] [--only a1,a2,a3,a4] [--out f]')
  process.exit(2)
}
const ROUNDS = Number(args.rounds)
const GAP = Number(args.gap)
const ONLY = (args.only ?? 'a1,a2,a3,a4').split(',').map(value => value.trim())
const BASE = `http://127.0.0.1:${PORT}`
const MEM = join(HOME, 'bot', 'memory')
const TEAM_MAIN = join(MEM, 'team', 'MEMORY.md')
const REVIEWED = join(MEM, 'reviewed.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
class RateLimited extends Error {}
let retries = 0

// The bench must be a bench. Its name is the one dev/bench.sh makes (.dsh-test-<name>),
// it cannot be the DSH_HOME this shell runs with, and every write this script makes goes
// through writeHere, which refuses a path outside it.
const HOME_ROOT = resolve(HOME)
const writes = []
function writeHere(path) {
  const abs = resolve(path)
  if (abs !== HOME_ROOT && !abs.startsWith(`${HOME_ROOT}${sep}`)) throw new Error(`refusing to write outside the bench home: ${abs}`)
  writes.push(abs)
  return abs
}
if (!/^\.dsh-test-[a-z0-9-]+$/.test(basename(HOME_ROOT))) throw new Error(`not a bench home (expected .dsh-test-<name>): ${HOME_ROOT}`)
if (process.env.DSH_HOME && resolve(process.env.DSH_HOME) === HOME_ROOT) throw new Error('the bench home is the DSH_HOME of this shell; point the bench at a .dsh-test-* home instead')


let cookie
async function api(endpoint, payload = {}) {
  if (cookie === undefined) {
    const url = readFileSync(join(HOME, 'web.log'), 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${PORT}/\\?token=\\S+`))?.[0]
    if (!url) throw new Error('no login URL in web.log')
    cookie = (await fetch(url, { redirect: 'manual' })).headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  }
  const response = await fetch(`${BASE}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}

async function settle({ quiet = 5000, timeout = 300_000 } = {}) {
  const deadline = Date.now() + timeout
  let since = Date.now()
  while (Date.now() < deadline) {
    await sleep(800)
    const view = await api('state')
    const busy = Object.keys(view.activity ?? {}).length > 0 || (view.memoryReviews ?? 0) > 0
    if (busy) since = Date.now()
    else if (Date.now() - since >= quiet) return
  }
  throw new Error('the team did not go quiet')
}

const readJsonLines = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
const tapLines = () => readJsonLines(args.tap)
const journal = () => readJsonLines(join(MEM, 'journal.jsonl'))
const reviewed = () => (existsSync(REVIEWED) ? JSON.parse(readFileSync(REVIEWED, 'utf8')) : {})
const teamChars = () => (existsSync(TEAM_MAIN) ? charsOf(readFileSync(TEAM_MAIN, 'utf8')) : 0)
const teamContent = () => (existsSync(TEAM_MAIN) ? readFileSync(TEAM_MAIN, 'utf8') : '')
function ensureTeamFile() {
  mkdirSync(writeHere(join(MEM, 'team')), { recursive: true })
  if (!existsSync(TEAM_MAIN)) writeFileSync(writeHere(TEAM_MAIN), '# Memory\n\n## Index\n', 'utf8')
}
// Body entries and index lines are counted apart. An index line is a bullet whose whole
// text is one [[topic]] link; a body entry that merely mentions [[topic]] is still a body
// entry, and counting it as an index both undercounts entries and inflates the index.
const entryLines = content => (content.match(/^\s*[-*]\s+.*$/gm) ?? [])
const bulletText = line => line.replace(/^\s*[-*]\s+/, '').trim()
const isIndexLine = line => /^\[\[[^\]]+\]\]$/.test(bulletText(line))
const entryCount = content => entryLines(content).filter(line => !isIndexLine(line)).length
const indexCount = content => entryLines(content).filter(isIndexLine).length
const ownMainPath = botId => join(MEM, 'bots', botId, 'MEMORY.md')
const readIf = path => (existsSync(path) ? readFileSync(path, 'utf8') : '')
// Character counts are on normalized line endings: the fixture is CRLF on disk, and the
// design's 3,765 is the same file counted after dropping the 87 carriage returns.
const charsOf = content => content.replace(/\r\n?/g, '\n').length
const oneScope = content => ({ chars: charsOf(content), body: entryCount(content), index: indexCount(content) })
// Team and its own memory are reported apart: growth in one must not hide growth in the
// other (the before run wrote 8 entries into the Bot's own file while the team file held).
const scopeStats = bot => ({ team: oneScope(teamContent()), own: oneScope(readIf(ownMainPath(bot.id))) })
const statLine = stats => `team ${stats.team.body}b/${stats.team.index}i/${stats.team.chars}c, own ${stats.own.body}b/${stats.own.index}i/${stats.own.chars}c`
const opCount = (events, op) => events.filter(event => event.op === op).length
// A write that saves an entry. `skip` is a refusal, not a save; it must never count as landed.
// A save is a write this turn: add, replace or move. `skip` is a refusal, not a save.
// What the entry means is not judged here; semantic checks are a manual spot-check.
const WRITE_OPS = new Set(['add', 'replace', 'move'])
const isSave = event => WRITE_OPS.has(event.op)

const say = line => console.log(line)
async function mainBot() {
  const view = await api('state')
  return view.bots.find(bot => bot.id === view.mainBotId)
}

// One cheap call before a round. A 429 here means the route is still cooling down, so the
// round never starts: a rate-limited round cannot be mistaken for a clean one.
async function probe() {
  const bot = await mainBot()
  const mark = tapLines().length
  await send(bot.id, '只回一个字：好')
  await settle({ quiet: 3000, timeout: 120_000 })
  const calls = tapLines().slice(mark)
  const limited = calls.filter(call => call.status === 429)
  const answered = calls.some(call => call.status === 200 && call.text !== undefined)
  if (!answered) throw new RateLimited('the probe before the round got no answer')
  say(`  probe: ${calls.length} calls, ${limited.length} rate limited, no stop`)
}
async function send(target, text) {
  const view = await api('state')
  const id = target.startsWith('#') ? view.rooms.find(room => room.name === target.slice(1)).id : view.bots.find(bot => bot.name === target || bot.id === target).id
  await api('send', { sessionId: id, text })
  // The route cools down under load: one call every GAP ms, never a burst.
  if (GAP > 0) await sleep(GAP)
}

// A bench may start empty: one Main Bot is all these scenarios need. A bench that already
// has one keeps it, but on the model this run was told to use.
async function ensureMainBot() {
  let view = await api('state')
  if (view.bots.length === 0) {
    await api('create-bot', { name: 'Chief', role: 'Lead', model: MODEL })
    view = await api('state')
  }
  if (!view.mainBotId) await api('set-main', { id: view.bots[0].id })
  const bot = view.bots[0]
  if (bot.model !== MODEL) {
    await api('update-bot', { id: bot.id, model: MODEL })
    say(`  bot ${bot.name}: model ${bot.model ?? '-'} -> ${MODEL}`)
  }
  ensureTeamFile()
}

async function step(title, run) {
  const tapMark = tapLines().length
  const journalMark = journal().length
  const started = Date.now()
  try {
    await run()
    await settle()
  } catch (error) {
    say(`  ERROR ${title}: ${error.message}`)
  }
  const calls = tapLines().slice(tapMark)
  const writes = journal().slice(journalMark)
  const tools = calls.flatMap(call => call.tools ?? [])
  say(`  ${title}: ${calls.length} calls [${tools.join(' ') || '-'}], ${writes.length} writes, ${((Date.now() - started) / 1000).toFixed(1)} s`)
  // A rate-limited attempt is a retry the provider had to swallow, not a lost step: the
  // bench provider retries twice. Only a step where nothing got through is fatal.
  const limited = calls.filter(call => call.status === 429 || /rate limit/i.test(call.error ?? ''))
  const answered = calls.some(call => call.status === 200 && call.text !== undefined)
  if (limited.length > 0) {
    retries += limited.length
    say(`    ${limited.length} rate-limited attempt(s), ${answered ? 'the step still answered' : 'the step got no answer'}`)
    if (!answered) throw new RateLimited(`${limited.length} attempts were rate limited and none got through`)
  }
  return { calls, writes, tools }
}

// ---------------------------------------------------------------------------
// Scenario 1 (A1): a full MEMORY.md, twelve things to remember, and what the Bot does
// when the write is refused. Stop line: at least 10 of 12 land, in main or in a topic.

const FACTS = [
  '周会固定在每周二上午十点，地点是 A 座 3 层的小会议室。',
  '代码评审要求至少两人通过才能合并，紧急修复也要事后补一次。',
  '部署窗口只有工作日的晚上八点到十一点，周末不发布。',
  '线上故障的等级用 P0 到 P3，P0 必须十五分钟内响应。',
  '测试环境的数据每周一早上重置，重置前会把库备份到归档盘。',
  '客户 A 的合同到 2027 年 3 月 31 日，续约要提前两个月启动。',
  '新同事入职第一周只做文档和测试，不直接改生产代码。',
  '所有对外接口都要有版本号，破坏性改动必须升大版本。',
  '安全扫描每周五下午跑一次，高危项必须在下周一前处理完。',
  '我们的日志保留 30 天，超过 30 天的会被自动清理。',
  '需求评审要提前两天发材料，否则当次不评审。',
  '值班表每两周轮换一次，节假日的值班另排。',
]

async function roundA1(round) {
  // Three separate counts, each with its own evidence, never one standing in for another:
  //   landed      — a journal write in that turn (the only hard evidence of a save)
  //   refused     — the turn's answer text quotes the capacity refusal. A lower bound:
  //                 the tool result is not in the tap, so a refusal the model did not
  //                 repeat is not counted.
  //   repeatWrites— the turn made two or more write calls (remember/forget). A retry after
  //                 a refusal looks like this, but so does any turn that wrote twice, so it
  //                 is a proxy for "wrote more than once", not proof of a cleanup.
  const report = { scenario: 'A1', round, attempted: 0, landed: 0, landedAny: 0, refused: 0, repeatWrites: 0, skips: 0, replaces: 0, moves: 0, details: [] }
  if (args['team-source']) {
    mkdirSync(writeHere(join(MEM, 'team')), { recursive: true })
    copyFileSync(args['team-source'], writeHere(TEAM_MAIN))
  }
  ensureTeamFile()
  report.startChars = teamChars()
  const chief = await mainBot()
  report.startStats = scopeStats(chief)
  say(`  start: ${statLine(report.startStats)}`)
  report.ops = {}
  const table = []
  for (const [index, fact] of FACTS.entries()) {
    report.attempted += 1
    const charsBefore = teamChars()
    const result = await step(`remember ${index + 1}`, () => send(chief.id, `把这条记进团队记忆（remember 带 scope: "team"），很重要：${fact}`))
    const charsAfter = teamChars()
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    const refused = /would have \d+ of its \d+ characters/.test(answer)
    // Mechanical only: did this turn save anything (add/replace/move), and where. The team
    // scope is what this scenario measures: the full file is team/MEMORY.md, and a write to
    // the Bot's own memory would never meet its limit.
    const wrote = result.writes.some(isSave)
    const wroteTeam = result.writes.some(change => isSave(change) && String(change.scope ?? '') === 'team')
    const writeCalls = result.tools.filter(name => name === 'remember' || name === 'forget').length
    const ops = result.writes.map(change => `${change.op}@${String(change.scope ?? '?')}:${change.file ?? '?'}`)
    for (const op of ops) report.ops[op] = (report.ops[op] ?? 0) + 1
    report.skips += opCount(result.writes, 'skip')
    report.replaces += opCount(result.writes, 'replace')
    report.moves += opCount(result.writes, 'move')
    if (wrote) report.landedAny += 1
    if (wroteTeam) report.landed += 1
    if (refused) report.refused += 1
    if (writeCalls > 1) report.repeatWrites += 1
    report.details.push({ fact: fact.slice(0, 12), refused, wrote, wroteTeam, writeCalls, ops, chars: [charsBefore, charsAfter], tools: result.tools })
    table.push(`    ${String(index + 1).padStart(2)} ${(ops.join(' ') || 'no write').padEnd(30)} ${charsBefore} -> ${charsAfter}`)
  }
  say('  per write (from journal.jsonl):')
  for (const line of table) say(line)
  say(`  ops in total: ${Object.entries(report.ops).map(([op, count]) => `${op}=${count}`).join(' ') || 'none'}`)
  report.endChars = teamChars()
  report.endStats = scopeStats(chief)
  report.entries = report.endStats.team.body
  report.index = report.endStats.team.index
  report.pass = report.landed >= 10
  say(`  A1 r${round}: landed team ${report.landed}/12 (any scope ${report.landedAny}/12), refused ${report.refused}, skips ${report.skips}, replace ${report.replaces}, move ${report.moves}, ${statLine(report.endStats)} ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario 2 (A2): twenty things said in passing, and what the review writes.
// Stop line: entries grow by at most 14, the file never fills up, no refusal, and the
// review cursor moves on.

const REVIEW_INPUT = [
  '我下周一到周三在杭州出差，这几天别约会议。',
  '我们组的代码风格是单引号、不加分号。',
  '客户 B 的对接人换成了一位姓陈的女士。',
  '构建时间最近从 4 分钟涨到了 9 分钟，正在排查。',
  '以后给我写周报，控制在五条以内。',
  '明年的技术选型倾向于继续用 PostgreSQL。',
  '我比较喜欢先看结论，再看论据。',
  '团队现在一共十二个人，年后可能再招两个。',
  'CI 用的是 GitHub Actions，自托管跑在内部机器上。',
  '文档统一放 Confluence，代码注释用英文。',
  '我不喜欢开长会，超过半小时的会我一般会推掉。',
  '线上环境的数据库每天凌晨三点做全量备份。',
  '新的监控面板还没做完，先用旧的。',
  '采购流程要走财务审批，一般三到五个工作日。',
  '测试覆盖率的要求是核心模块不低于 70%。',
  '最近在推进把日志从文本换成 JSON。',
  '下个季度的重点是降低部署失败率。',
  '我不看 PPT，有数据直接发文档。',
  '团队每两周做一次复盘，形式是半小时的圆桌。',
  '客户 A 那边希望我们支持单点登录。',
]

async function roundA2(round) {
  const report = { scenario: 'A2', round }
  ensureTeamFile()
  const chief = await mainBot()
  report.startStats = scopeStats(chief)
  report.startEntries = report.startStats.team.body
  report.startChars = report.startStats.team.chars
  let reviews = 0
  const writes = []
  // The team file is the one that fills up, so this round asks for team writes first; own is
  // the control. The review still chooses the scope, and both are reported. The primer's turn
  // is inside the window the files are measured over, so its reviews and writes count here.
  const primer = await step('scope primer', () => send(chief.id, '以后团队相关的事请写进团队记忆（remember 带 scope: "team"）；个人偏好可以写我自己的记忆。'))
  reviews += primer.calls.filter(call => call.kind === 'review').length
  writes.push(...primer.writes)
  // Read after the primer: the twenty inputs themselves have to move the review's place, or a
  // primer that moved it would make a batch phase that never reviewed look like progress.
  const cursorStart = reviewed()
  // Batches of four keep the turn count, and the cost, bounded.
  for (let index = 0; index < REVIEW_INPUT.length; index += 4) {
    const batch = REVIEW_INPUT.slice(index, index + 4)
    const result = await step(`chat ${index / 4 + 1}`, async () => {
      for (const line of batch) await send((await mainBot()).id, line)
    })
    reviews += result.calls.filter(call => call.kind === 'review').length
    writes.push(...result.writes)
  }
  report.endStats = scopeStats(chief)
  report.endEntries = report.endStats.team.body
  report.endChars = report.endStats.team.chars
  report.reviews = reviews
  const cursorAfter = reviewed()
  // The review runs per Session, and this round speaks to the main Bot's own chat: only its
  // place moving counts. Another chat advancing is reported, never judged as progress here.
  const cursorKey = `chat:${chief.id}`
  const cursor = cursorProgress(cursorStart, cursorAfter, cursorKey)
  report.cursor = { key: cursorKey, from: cursorStart[cursorKey] ?? null, to: cursorAfter[cursorKey] ?? null, elsewhere: cursor.elsewhere, regressed: cursor.regressed }
  report.cursorMoved = cursor.moved
  report.delta = report.endEntries - report.startEntries
  report.ownDelta = report.endStats.own.body - report.startStats.own.body
  report.indexDelta = report.endStats.team.index - report.startStats.team.index
  report.overLimit = [report.startStats.team, report.endStats.team, report.startStats.own, report.endStats.own].some(scope => scope.chars > 4_000)
  report.replaces = opCount(writes, 'replace')
  report.teamReplaces = writes.filter(event => event.op === 'replace' && String(event.scope ?? '') === 'team').length
  report.ownReplaces = writes.filter(event => event.op === 'replace' && String(event.scope ?? '') !== 'team').length
  report.skips = opCount(writes, 'skip')
  report.moves = opCount(writes, 'move')
  // Raw writes for the manual spot-check: whether a replace merged the right entries is
  // judged by a person, not by a string probe. Full text, no truncation.
  report.samples = writes.map(event => ({
    scenario: 'A2',
    round,
    kind: 'write',
    op: event.op ?? null,
    scope: String(event.scope ?? ''),
    file: event.file ?? null,
    text: event.after ?? event.text ?? event.before ?? '',
  })).filter(sample => sample.text !== '')
  // Mechanical only: growth stays within budget in both files, topics do not multiply, the
  // review ran, and its place moved through the twenty inputs themselves. The replace count is
  // printed, not judged: A2 has no update among its messages.
  report.pass = a2Pass({ delta: report.delta, ownDelta: report.ownDelta, indexDelta: report.indexDelta, overLimit: report.overLimit, cursorMoved: report.cursorMoved, reviews })
  say(`  A2 r${round}: team Δ${report.delta} (replace ${report.teamReplaces}, reported), own Δ${report.ownDelta} (replace ${report.ownReplaces}), index ${report.startStats.team.index} → ${report.endStats.team.index} (Δ${report.indexDelta}), reviews ${reviews}, skip ${report.skips}, move ${report.moves}, cursor ${report.cursorMoved} (${cursorKey} ${report.cursor.from} → ${report.cursor.to}, ${cursor.elsewhere.length} other key(s) advanced), ${statLine(report.endStats)} ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario 3 (A3): recall is called for five queries, in one session over entries that were
// injected at session start, added during the session, and topic-only. Judged mechanically:
// every query must call recall. What came back is printed for the manual spot-check; asking
// a string test whether a Chinese fact "was saved" only produced false passes and false
// failures on paraphrase.

const INJECTED_FACTS = ['团队的周会在周二上午十点。', '部署窗口是工作日晚上八点到十一点。']
const ADDED_FACTS = ['我这次记忆基准用的临时标记是 ZQ7。', '我们新换的构建机编号是 B-42。']
const TOPIC_FACTS = ['旧版接口的兼容层计划在四月下线。']
const A3_QUERIES = ['周会是什么时候？', '部署窗口是几点？', '临时标记 ZQ7 是什么？', '构建机编号是多少？', '旧版接口的兼容层什么时候下线？']
// Read the model's quoted recall result for the manual sample; never used as a pass test.
const recallLines = answer => {
  const fenced = [...answer.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map(match => match[1]).join('\n')
  const text = fenced.trim() !== '' ? fenced : answer
  return text.split('\n').map(line => line.trim()).filter(line => /^\[[^\]]+\]\s/.test(line)).join('\n')
}
const askRecall = (chief, query) => send(chief.id, `用 recall 查一下「${query}」，把 recall 工具返回的原始文本原样贴出来（原文，不要转述）。`)

async function roundA3(round) {
  const report = { scenario: 'A3', round, results: [], samples: [] }
  const chief = await mainBot()
  // Class 1: already in the team MEMORY.md, so the session's snapshot carries them.
  const seeded = teamContent().replace(/\n## Team memory[\s\S]*$/, '')
  writeFileSync(writeHere(TEAM_MAIN), `${seeded}${seeded.endsWith('\n') ? '' : '\n'}- ${INJECTED_FACTS.join('\n- ')}\n`, 'utf8')
  // A fresh session: end the running one by starting a new chat for this Bot.
  await step('new session', async () => { await send(chief.id, '我们开始一个新话题，先打个招呼就行。') })
  await step('topic entry', async () => { await send(chief.id, `把这条记进 [[运维]] 主题：${TOPIC_FACTS[0]}`) })
  await step('added during the session', async () => {
    for (const fact of ADDED_FACTS) await send(chief.id, `记住：${fact}`)
  })
  for (const query of A3_QUERIES) {
    const result = await step(`recall ${query.slice(0, 6)}`, () => askRecall(chief, query))
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    const returned = recallLines(answer)
    report.results.push({ query, recalled: result.tools.includes('recall'), citations: (returned.match(/#L\d+/g) ?? []).length })
    if (returned !== '') {
      report.samples.push({ scenario: 'A3', round, kind: 'recall', query, text: returned })
    }
  }
  report.recalls = report.results.filter(item => item.recalled).length
  report.pass = report.recalls === A3_QUERIES.length
  say(`  A3 r${round}: recall called for ${report.recalls}/5 queries; ${report.samples.length} returned lines saved for the manual check ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario 4 (A4): five recall calls; judged mechanically on whether the result carries a
// `文件#L行号` citation. Which line it names is the manual spot-check, not a string match.
// Stop line: 5/5 queries call recall and 5/5 results carry a citation.

const A4_CASES = [
  { fact: '周会固定在每周二上午十点，地点是小会议室。', query: '周会几点开、在哪？' },
  { fact: '部署窗口是工作日晚上八点到十一点。', query: '部署窗口是几点？' },
  { fact: '构建机编号是 B-42。', query: '构建机编号是多少？' },
  { fact: '日志保留 30 天。', query: '日志保留多久？' },
  { fact: '安全扫描每周五下午跑。', query: '安全扫描什么时候跑？' },
]

async function roundA4(round) {
  const report = { scenario: 'A4', round, checks: [], samples: [] }
  const chief = await mainBot()
  const seeded = teamContent()
  const missing = A4_CASES.map(item => item.fact).filter(fact => !seeded.includes(fact.replace(/[。！？]+$/u, '').slice(-12)))
  if (missing.length > 0) {
    const tail = `${seeded}${seeded.endsWith('\n') ? '' : '\n'}${missing.map(fact => `- ${fact}`).join('\n')}\n`
    writeFileSync(writeHere(TEAM_MAIN), tail, 'utf8')
  }
  for (const item of A4_CASES) {
    const result = await step(`recall ${item.query.slice(0, 6)}`, () => askRecall(chief, item.query))
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    const returned = recallLines(answer)
    const citations = (returned.match(/#L\d+/g) ?? []).length
    report.checks.push({ query: item.query, recalled: result.tools.includes('recall'), citations })
    if (returned !== '') {
      report.samples.push({ scenario: 'A4', round, kind: 'recall', query: item.query, text: returned })
    }
  }
  report.recalls = report.checks.filter(check => check.recalled).length
  report.cited = report.checks.filter(check => check.citations > 0).length
  // No pass/fail: whether a citation names the right line is a person's call. The mechanical
  // part (recall called, citation present) is reported, not scored.
  say(`  A4 r${round}: recall called ${report.recalls}/5, results with a citation ${report.cited}/5 (manual check)`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario A2b: a fact the team memory already holds changes. The review has to edit that
// entry, not add a second one: two entries about the same thing leave the next turn unable to
// tell which is current. Judged mechanically on the journal and the file.

const A2B_SEED = '周报控制在五条以内'
const A2B_UPDATE = '团队记忆里周报那条以后改成三条以内'
// Every file the team keeps: a fact moved into a topic is still the one entry, not a lost one.
const teamEntriesAll = () => {
  const dir = join(MEM, 'team')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.md')).flatMap(name => {
    const content = readFileSync(join(dir, name), 'utf8')
    return entryLines(content).filter(line => !isIndexLine(line)).map(line => ({ text: bulletText(line), file: name }))
  })
}

async function roundA2b(round) {
  const report = { scenario: 'A2B', round }
  // A small team file with the fact already saved, next to other entries it must leave alone.
  const seed = [
    '# Memory',
    '',
    '- 团队周会在每周二上午十点 [source: part 1 #1; by: Chief; added: 2026-01-05]',
    `- ${A2B_SEED} [source: part 1 #2; by: Chief; added: 2026-01-05]`,
    '- 客户 A 的合同到 2027 年 3 月 31 日 [source: part 1 #3; by: Chief; added: 2026-01-05]',
    '',
    '## Index',
    '',
  ].join('\n')
  mkdirSync(writeHere(join(MEM, 'team')), { recursive: true })
  writeFileSync(writeHere(TEAM_MAIN), seed, 'utf8')
  const chief = await mainBot()
  const indexBefore = indexCount(teamContent())
  const cursorBefore = reviewed()
  const result = await step('update 周报', () => send(chief.id, `记一下：${A2B_UPDATE}。`))
  // Only the review's own writes count: the Bot saves the message itself in many runs, and a
  // change the Bot made says nothing about the review this scenario is for.
  const auto = result.writes.filter(event => event.auto === true)
  const teamReplaces = auto.filter(event => event.op === 'replace' && String(event.scope ?? '') === 'team')
  const weekly = teamEntriesAll().filter(entry => entry.text.includes('周报'))
  report.replaces = teamReplaces.length
  report.autoWrites = auto.length
  report.weekly = weekly.map(entry => `${entry.file}: ${entry.text}`)
  report.indexBefore = indexBefore
  report.index = indexCount(teamContent())
  report.cursorMoved = cursorProgress(cursorBefore, reviewed(), `chat:${chief.id}`).moved
  // The outcome, not the op: two entries about the weekly report leave the next turn unable to
  // tell which is current, and that is the failure this scenario exists for. One entry saying
  // the new number passes; one entry still saying the old number is "did not act", counted
  // neither way here — the run's verdict is the count over three rounds. All team files are
  // read, so a fact moved into a topic is one entry, not a lost one.
  report.outcome = a2bOutcome(weekly)
  report.pass = report.outcome === 'updated'
  report.samples = teamReplaces.map(event => ({
    scenario: 'A2B',
    round,
    kind: 'write',
    op: event.op,
    scope: String(event.scope ?? ''),
    file: event.file ?? null,
    text: event.after ?? event.text ?? event.before ?? '',
  }))
  say(`  A2b r${round}: ${report.outcome} (周报 entries ${weekly.length} across ${new Set(weekly.map(entry => entry.file)).size} file(s)), review writes ${report.autoWrites}, team replace ${report.replaces}, index ${report.indexBefore} → ${report.index}, cursor ${report.cursorMoved}`)
  for (const entry of weekly) say(`    ${entry.file}: ${entry.text}`)
  return report
}

// ---------------------------------------------------------------------------

await ensureMainBot()
const tapStart = tapLines().length
const report = { model: MODEL, home: HOME, started: new Date().toISOString(), rounds: [] }
const runners = { a1: roundA1, a2: roundA2, a2b: roundA2b, a3: roundA3, a4: roundA4 }
let stoppedEarly = false
for (const name of ONLY) {
  if (stoppedEarly) break
  const runner = runners[name]
  if (!runner) { console.error(`unknown scenario ${name}`); process.exit(2) }
  for (let round = 1; round <= ROUNDS; round += 1) {
    say(`\n=== ${name.toUpperCase()} round ${round}`)
    const retriesBefore = retries
    try {
      await probe()
      const result = await runner(round)
      result.retries = retries - retriesBefore
      if (result.retries > 0) say(`  retries this round: ${result.retries} rate-limited attempts, all answered`)
      report.rounds.push(result)
    } catch (error) {
      say(`  ERROR ${name} r${round}: ${error.message}`)
      // A4 is a manual check: no pass/fail on any path, including an error.
      const failed = { scenario: name.toUpperCase(), round, error: error.message }
      if (name !== 'a4') failed.pass = false
      report.rounds.push(failed)
      if (error instanceof RateLimited) {
        say('  rate limited: stopping the run; only the rounds that finished are reported')
        report.rateLimited = true
        stoppedEarly = true
        break
      }
    }
  }
}
for (const scenario of ONLY.map(name => name.toUpperCase())) {
  const rounds = report.rounds.filter(item => item.scenario === scenario)
  // A2b is judged over three completed rounds: no round may leave two entries about the fact,
  // and at least two must end with one entry saying the new value. A round that errored, or
  // never reached its outcome, is not a round: counting it either way would let a run pass on
  // two results and a crash.
  if (scenario === 'A2B') {
    const summary = a2bSummary(rounds)
    say(`\nA2B: ${summary.updated}/${summary.done} updated, ${summary.bad} duplicate or lost, ${summary.incomplete} incomplete${summary.done >= 3 ? '' : ' (three completed rounds needed)'} → ${summary.pass ? 'PASS' : 'FAIL'}`)
    continue
  }
  if (rounds.length > 0 && rounds.every(item => item.pass === undefined)) {
    say(`\n${scenario}: manual check (no pass/fail)`)
    continue
  }
  const passed = rounds.filter(item => item.pass).length
  say(`\n${scenario}: ${passed}/${rounds.length} rounds pass`)
}
// The manual spot-check: raw writes and returned lines, printed whole for a person to
// judge. Nothing here is pass/fail; semantic equivalence is not a string test.
const samples = report.rounds.flatMap(item => item.samples ?? [])
const shown = samples.slice(0, 5)
const sampleNote = samples.length < 5 ? `only ${samples.length}, not 5` : `first 5 of ${samples.length}`
say(`\nmanual spot-check: ${sampleNote}`)
for (const [index, sample] of shown.entries()) {
  say(`  ${index + 1}. [${sample.scenario} r${sample.round} ${sample.kind}] op=${sample.op ?? '-'} scope=${sample.scope ?? '-'} file=${sample.file ?? '-'} query=${sample.query ?? '-'}`)
  say(`     ${String(sample.text).replace(/\n/g, '\n     ')}`)
}
report.manualSamples = samples
const calls = tapLines()
// A run is counted from where it started: the tap file may already hold smoke runs.
say(`model calls in this run: ${calls.length - tapStart}; in the tap so far: ${calls.length}`)
report.calls = { run: calls.length - tapStart, tapTotal: calls.length }
// The zero-touch check: every write this run made, and the home it stayed inside.
const outside = writes.filter(path => path !== HOME_ROOT && !path.startsWith(`${HOME_ROOT}${sep}`))
say(`writes: ${writes.length} inside ${HOME_ROOT}, ${outside.length} outside`)
if (outside.length > 0) {
  say(`OUTSIDE THE BENCH HOME: ${outside.join(', ')}`)
  process.exitCode = 1
}
report.guard = { home: HOME_ROOT, writes: writes.length, outside }
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8')
