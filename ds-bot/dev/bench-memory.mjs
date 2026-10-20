// The ruler for the memory work (issues #1-#4): four scenarios on a running bench with a
// real model, three rounds each, every round reported. Nothing here touches the real
// memory or the real Bot team: it runs against a bench home and a copy of MEMORY.md.
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
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tap: { type: 'string' },
    'team-source': { type: 'string' },
    rounds: { type: 'string', default: '3' },
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
const ONLY = (args.only ?? 'a1,a2,a3,a4').split(',').map(value => value.trim())
const BASE = `http://127.0.0.1:${PORT}`
const MEM = join(HOME, 'bot', 'memory')
const TEAM_MAIN = join(MEM, 'team', 'MEMORY.md')
const REVIEWED = join(MEM, 'reviewed.json')
const SNAPSHOTS = join(MEM, 'snapshots')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
class RateLimited extends Error {}

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
const teamChars = () => (existsSync(TEAM_MAIN) ? readFileSync(TEAM_MAIN, 'utf8').length : 0)
const teamContent = () => (existsSync(TEAM_MAIN) ? readFileSync(TEAM_MAIN, 'utf8') : '')
function ensureTeamFile() {
  mkdirSync(writeHere(join(MEM, 'team')), { recursive: true })
  if (!existsSync(TEAM_MAIN)) writeFileSync(writeHere(TEAM_MAIN), '# Memory\n\n## Index\n', 'utf8')
}
const entryCount = content => (content.match(/^\s*[-*]\s+/gm) ?? []).length
const snaps = () => (existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS).filter(name => name.endsWith('.md')).map(name => ({ name, content: readFileSync(join(SNAPSHOTS, name), 'utf8') })) : [])

const say = line => console.log(line)
const botNamed = async name => (await api('state')).bots.find(bot => bot.name === name)
async function mainBot() {
  const view = await api('state')
  return view.bots.find(bot => bot.id === view.mainBotId)
}
async function send(target, text) {
  const view = await api('state')
  const id = target.startsWith('#') ? view.rooms.find(room => room.name === target.slice(1)).id : view.bots.find(bot => bot.name === target || bot.id === target).id
  await api('send', { sessionId: id, text })
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
  // A rate-limited round measured nothing: stop the whole run and report what finished.
  const limited = calls.filter(call => call.status === 429 || /rate limit/i.test(call.error ?? ''))
  if (limited.length > 0) throw new RateLimited(`${limited.length} of ${calls.length} calls were rate limited (${limited[0].error?.error?.message ?? limited[0].error ?? '429'})`)
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
  const report = { scenario: 'A1', round, attempted: 0, landed: 0, rejected: 0, followUp: 0, details: [] }
  if (args['team-source']) {
    mkdirSync(writeHere(join(MEM, 'team')), { recursive: true })
    copyFileSync(args['team-source'], writeHere(TEAM_MAIN))
  }
  ensureTeamFile()
  report.startChars = teamChars()
  say(`  start: MEMORY.md ${report.startChars} characters, ${entryCount(teamContent())} entries`)
  const chief = await mainBot()
  for (const [index, fact] of FACTS.entries()) {
    report.attempted += 1
    const result = await step(`remember ${index + 1}`, () => send(chief.id, `把这条记进长期记忆，很重要：${fact}`))
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    const refused = /would have \d+ of its \d+ characters/.test(answer)
    const wrote = result.writes.length > 0
    const writeCalls = result.tools.filter(name => name === 'remember' || name === 'forget').length
    if (wrote) report.landed += 1
    if (refused) report.rejected += 1
    if (wrote && writeCalls > 1) report.followUp += 1
    report.details.push({ fact: fact.slice(0, 12), refused, wrote, writeCalls, tools: result.tools })
  }
  report.endChars = teamChars()
  report.entries = entryCount(teamContent())
  report.pass = report.landed >= 10
  say(`  A1 r${round}: landed ${report.landed}/12, refused ${report.rejected}, follow-up ${report.followUp}, chars ${report.startChars} -> ${report.endChars} ${report.pass ? 'PASS' : 'FAIL'}`)
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
  const before = teamContent()
  report.startEntries = entryCount(before)
  report.startChars = before.length
  const cursorBefore = JSON.stringify(reviewed())
  let reviews = 0
  // Batches of four keep the turn count, and the cost, bounded.
  for (let index = 0; index < REVIEW_INPUT.length; index += 4) {
    const batch = REVIEW_INPUT.slice(index, index + 4)
    const result = await step(`chat ${index / 4 + 1}`, async () => {
      for (const line of batch) await send((await mainBot()).id, line)
    })
    reviews += result.calls.filter(call => call.kind === 'review').length
  }
  const after = teamContent()
  report.endEntries = entryCount(after)
  report.endChars = after.length
  report.reviews = reviews
  report.cursorMoved = JSON.stringify(reviewed()) !== cursorBefore
  report.delta = report.endEntries - report.startEntries
  report.overLimit = report.endChars > 4_000
  // A round without a single review measured nothing, so it cannot pass.
  report.pass = report.delta <= 14 && !report.overLimit && report.cursorMoved && reviews >= 1
  say(`  A2 r${round}: entries ${report.startEntries} -> ${report.endEntries} (Δ${report.delta}), chars ${report.startChars} -> ${report.endChars}, reviews ${reviews}, cursor moved ${report.cursorMoved} ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario 3 (A3): recall in one session over three classes of entry — already in the
// prompt at session start, added during the session, topic only. Stop line: nothing that
// is already in the snapshot comes back, the other two classes still do.

const INJECTED_FACTS = ['团队的周会在周二上午十点。', '部署窗口是工作日晚上八点到十一点。']
const ADDED_FACTS = ['我这次记忆基准用的临时标记是 ZQ7。', '我们新换的构建机编号是 B-42。']
const TOPIC_FACTS = ['旧版接口的兼容层计划在四月下线。']
const QUERIES = ['周会是什么时候？', '部署窗口是几点？', '临时标记 ZQ7 是什么？', '构建机编号是多少？', '旧版接口的兼容层什么时候下线？']

async function roundA3(round) {
  const report = { scenario: 'A3', round, results: [] }
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
  const snapshot = snaps().map(file => file.content).join('\n')
  for (const query of QUERIES) {
    const result = await step(`recall ${query.slice(0, 6)}`, () => send(chief.id, `用 recall 查一下「${query}」，把你的 recall 工具原始输出原样贴出来，不要转述。`))
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    report.results.push({
      query,
      recalled: result.tools.includes('recall'),
      injectedReturned: INJECTED_FACTS.filter(fact => answer.includes(fact.slice(0, 6))).length,
      lines: (answer.match(/#L\d+/g) ?? []).length,
      answer: answer.slice(0, 600),
      inSnapshot: INJECTED_FACTS.filter(fact => snapshot.includes(fact.slice(0, 6))).length,
    })
  }
  report.injectedReturned = report.results.reduce((sum, item) => sum + item.injectedReturned, 0)
  report.lineNumbers = report.results.reduce((sum, item) => sum + item.lines, 0)
  report.recalls = report.results.filter(item => item.recalled).length
  report.pass = report.injectedReturned === 0 && report.recalls === QUERIES.length
  say(`  A3 r${round}: recalls ${report.recalls}/5, injected entries returned ${report.injectedReturned}, line refs ${report.lineNumbers}, snapshot has ${report.results[0]?.inSnapshot ?? 0}/2 ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario 4 (A4): five recall results, each one checked against the file it names.
// Stop line: 5/5 point at the line that holds the entry.

async function roundA4(round) {
  const report = { scenario: 'A4', round, checks: [] }
  const chief = await mainBot()
  for (const query of QUERIES) {
    const result = await step(`recall ${query.slice(0, 6)}`, () => send(chief.id, `用 recall 查一下「${query}」，把结果原样贴出来，包括每条后面的出处。`))
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    const refs = [...answer.matchAll(/([^\s（）()]+MEMORY\.md|\S+\.md)#L(\d+)/g)].map(match => ({ file: match[1], line: Number(match[2]) }))
    for (const ref of refs.slice(0, 1)) {
      const path = ref.file.includes('/') || ref.file.includes('\\') ? ref.file : join(MEM, 'team', ref.file)
      const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
      const text = (lines[ref.line - 1] ?? '').trim()
      report.checks.push({ query, ref: `${ref.file}#L${ref.line}`, ok: text.length > 0, text: text.slice(0, 80) })
    }
  }
  report.found = report.checks.length
  report.ok = report.checks.filter(check => check.ok).length
  report.pass = report.ok >= 5
  say(`  A4 r${round}: ${report.ok}/${Math.max(report.found, 5)} line references check out ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------

await ensureMainBot()
const tapStart = tapLines().length
const report = { model: MODEL, home: HOME, started: new Date().toISOString(), rounds: [] }
const runners = { a1: roundA1, a2: roundA2, a3: roundA3, a4: roundA4 }
let stoppedEarly = false
for (const name of ONLY) {
  if (stoppedEarly) break
  const runner = runners[name]
  if (!runner) { console.error(`unknown scenario ${name}`); process.exit(2) }
  for (let round = 1; round <= ROUNDS; round += 1) {
    say(`\n=== ${name.toUpperCase()} round ${round}`)
    try {
      report.rounds.push(await runner(round))
    } catch (error) {
      say(`  ERROR ${name} r${round}: ${error.message}`)
      report.rounds.push({ scenario: name.toUpperCase(), round, error: error.message, pass: false })
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
  const passed = rounds.filter(item => item.pass).length
  say(`\n${scenario}: ${passed}/${rounds.length} rounds pass`)
}
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
