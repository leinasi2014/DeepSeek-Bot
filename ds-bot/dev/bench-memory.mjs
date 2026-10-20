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
const SNAPSHOTS = join(MEM, 'snapshots')
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
const teamChars = () => (existsSync(TEAM_MAIN) ? readFileSync(TEAM_MAIN, 'utf8').length : 0)
const teamContent = () => (existsSync(TEAM_MAIN) ? readFileSync(TEAM_MAIN, 'utf8') : '')
function ensureTeamFile() {
  mkdirSync(writeHere(join(MEM, 'team')), { recursive: true })
  if (!existsSync(TEAM_MAIN)) writeFileSync(writeHere(TEAM_MAIN), '# Memory\n\n## Index\n', 'utf8')
}
// Body entries and index lines are counted apart: an index line links a topic and is not
// an entry. Counting both made every new topic look like a new fact.
const entryLines = content => (content.match(/^\s*[-*]\s+.*$/gm) ?? [])
const entryCount = content => entryLines(content).filter(line => !line.includes('[[')).length
const indexCount = content => entryLines(content).filter(line => line.includes('[[')).length
const ownMainPath = botId => join(MEM, 'bots', botId, 'MEMORY.md')
const readIf = path => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const oneScope = content => ({ chars: content.length, body: entryCount(content), index: indexCount(content) })
// Team and its own memory are reported apart: growth in one must not hide growth in the
// other (the before run wrote 8 entries into the Bot's own file while the team file held).
const scopeStats = bot => ({ team: oneScope(teamContent()), own: oneScope(readIf(ownMainPath(bot.id))) })
const statLine = stats => `team ${stats.team.body}b/${stats.team.index}i/${stats.team.chars}c, own ${stats.own.body}b/${stats.own.index}i/${stats.own.chars}c`
const opCount = (events, op) => events.filter(event => event.op === op).length
// A write that saves an entry. `skip` is a refusal, not a save; it must never count as landed.
const WRITE_OPS = new Set(['add', 'replace', 'move'])
const isSave = event => WRITE_OPS.has(event.op)
// A replace only counts as merging when it touches something this round actually said:
// rewriting an unrelated old entry must not earn the point.
const probeWords = line => {
  const latin = (line.match(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g) ?? []).concat(line.match(/\d+(?:\.\d+)?%?/g) ?? [])
  if (latin.length > 0) return [...new Set(latin)]
  const han = line.replace(/[，。！？、；：\s"'“”‘’（）()]/gu, '')
  return han.length >= 6 ? [han.slice(-6)] : []
}
const touches = (event, probes) => probes.some(probe => `${event.before ?? ''}\n${event.after ?? ''}`.includes(probe))
// Compare entry text without punctuation or spacing: a model may rephrase a comma away but
// still have saved the fact.
const normalize = text => String(text ?? '').replace(/[\s，。！？、；：,.!?;:（）()"'“”‘’]/gu, '')
// The probe a landed write must contain: the longest piece of the fact that the memory did
// not already hold. The seeded fixture repeats most of these facts word for word, so a
// fixed prefix or suffix would let a moved old entry count as the new fact; when the whole
// fact is already there, only the whole fact counts.
const novelWindow = (fact, known) => {
  const plain = normalize(fact)
  const held = normalize(known)
  for (let size = 12; size >= 6; size -= 1) {
    for (let at = 0; at + size <= plain.length; at += 1) {
      const probe = plain.slice(at, at + size)
      if (!held.includes(probe)) return probe
    }
  }
  return plain
}
// A save is this fact, not any write: it must contain a stretch of the fact the memory did
// not hold before this turn. One fixed window would false-fail on a rewrite that drops that
// exact phrase, so any novel window counts.
const savedFact = (after, fact, known) => {
  const text = normalize(after)
  const plain = normalize(fact)
  const held = normalize(known)
  for (let size = 12; size >= 8; size -= 1) {
    for (let at = 0; at + size <= plain.length; at += 1) {
      const probe = plain.slice(at, at + size)
      if (!held.includes(probe) && text.includes(probe)) return true
    }
  }
  return text.includes(plain)
}
const snaps = () => (existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS).filter(name => name.endsWith('.md')).map(name => ({ name, content: readFileSync(join(SNAPSHOTS, name), 'utf8') })) : [])

const say = line => console.log(line)
const botNamed = async name => (await api('state')).bots.find(bot => bot.name === name)
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
  const report = { scenario: 'A1', round, attempted: 0, landed: 0, refused: 0, repeatWrites: 0, skips: 0, replaces: 0, moves: 0, details: [] }
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
    const known = teamContent() + readIf(ownMainPath(chief.id))
    // Landed means *this* fact reached the journal as a save. The probe is the part of the
    // fact the memory did not hold before this turn, so a moved or rewritten old entry
    // cannot pass for the new fact, and `skip` (a refusal) never counts.
    const seed = novelWindow(fact, known)
    const charsBefore = teamChars()
    const result = await step(`remember ${index + 1}`, () => send(chief.id, `把这条记进长期记忆，很重要：${fact}`))
    const charsAfter = teamChars()
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    const refused = /would have \d+ of its \d+ characters/.test(answer)
    const wrote = result.writes.some(change => isSave(change) && typeof change.after === 'string' && savedFact(change.after, fact, known))
    const writeCalls = result.tools.filter(name => name === 'remember' || name === 'forget').length
    const ops = result.writes.map(change => change.file ? `${change.op}@${change.file}` : change.op ?? '?')
    for (const op of ops) report.ops[op] = (report.ops[op] ?? 0) + 1
    report.skips += opCount(result.writes, 'skip')
    report.replaces += opCount(result.writes, 'replace')
    report.moves += opCount(result.writes, 'move')
    if (wrote) report.landed += 1
    if (refused) report.refused += 1
    if (wrote && writeCalls > 1) report.repeatWrites += 1
    report.details.push({ fact: fact.slice(0, 12), refused, wrote, seed, writeCalls, ops, chars: [charsBefore, charsAfter], tools: result.tools })
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
  say(`  A1 r${round}: landed ${report.landed}/12, refused ${report.refused}, skips ${report.skips}, replace ${report.replaces}, move ${report.moves}, ${statLine(report.endStats)} ${report.pass ? 'PASS' : 'FAIL'}`)
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
  const cursorBefore = JSON.stringify(reviewed())
  let reviews = 0
  const writes = []
  // Batches of four keep the turn count, and the cost, bounded.
  for (let index = 0; index < REVIEW_INPUT.length; index += 4) {
    const batch = REVIEW_INPUT.slice(index, index + 4)
    const result = await step(`chat ${index / 4 + 1}`, async () => {
      for (const line of batch) await send((await mainBot()).id, line)
    })
    reviews += result.calls.filter(call => call.kind === 'review').length
    writes.push(...result.writes)
  }
  const after = teamContent()
  report.endStats = scopeStats(chief)
  report.endEntries = report.endStats.team.body
  report.endChars = report.endStats.team.chars
  report.reviews = reviews
  report.cursorMoved = JSON.stringify(reviewed()) !== cursorBefore
  report.delta = report.endEntries - report.startEntries
  report.ownDelta = report.endStats.own.body - report.startStats.own.body
  report.overLimit = report.startStats.team.chars > 4_000 || report.endStats.team.chars > 4_000 || report.endStats.own.chars > 4_000
  report.replaces = opCount(writes, 'replace')
  report.skips = opCount(writes, 'skip')
  report.moves = opCount(writes, 'move')
  const probes = REVIEW_INPUT.flatMap(probeWords)
  report.replacesRelated = writes.filter(event => event.op === 'replace'
    && typeof event.before === 'string' && typeof event.after === 'string'
    && event.before !== event.after && touches(event, probes)).length
  // A round without a single review measured nothing, so it cannot pass. `replace` is the
  // signal the write path merges instead of piling up; ten adds with zero replaces is the
  // behavior this bench exists to catch, and the point is only earned on this round's input.
  report.pass = report.delta <= 14 && report.ownDelta <= 14 && !report.overLimit && report.cursorMoved && reviews >= 1 && report.replacesRelated >= 1
  say(`  A2 r${round}: team Δ${report.delta}, own Δ${report.ownDelta}, reviews ${reviews}, replace ${report.replaces} (related ${report.replacesRelated}), skip ${report.skips}, move ${report.moves}, cursor ${report.cursorMoved}, ${statLine(report.endStats)} ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario 3 (A3): recall in one session over three classes of entry — already in the
// prompt at session start, added during the session, topic only. Stop line: nothing that
// is already in the snapshot comes back, the other two classes still do.

const INJECTED_FACTS = ['团队的周会在周二上午十点。', '部署窗口是工作日晚上八点到十一点。']
const ADDED_FACTS = ['我这次记忆基准用的临时标记是 ZQ7。', '我们新换的构建机编号是 B-42。']
const TOPIC_FACTS = ['旧版接口的兼容层计划在四月下线。']
const A3_CASES = [
  { query: '周会是什么时候？', forbid: '周二上午十点' },
  { query: '部署窗口是几点？', forbid: '晚上八点到十一点' },
  { query: '临时标记 ZQ7 是什么？', expect: 'ZQ7' },
  { query: '构建机编号是多少？', expect: 'B-42' },
  { query: '旧版接口的兼容层什么时候下线？', expect: '四月下线' },
]
// The recall result, not the model's prose, is what gets measured: the model must paste the
// tool output verbatim in a fenced block, and only lines shaped like a recall result count.
const recallLines = answer => {
  const fenced = [...answer.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map(match => match[1]).join('\n')
  const text = fenced.trim() !== '' ? fenced : answer
  return text.split('\n').map(line => line.trim()).filter(line => /^\[[^\]]+\]\s/.test(line)).join('\n')
}
const askRecall = (chief, query) => send(chief.id, `用 recall 查一下「${query}」，把 recall 工具返回的原始文本原样放进一个 \`\`\` 代码块（不要改字、不要转述、不要解释）。`)
const has = (text, needle) => needle !== undefined && text.includes(needle)

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
  for (const [index, item] of A3_CASES.entries()) {
    const result = await step(`recall ${item.query.slice(0, 6)}`, () => askRecall(chief, item.query))
    const answer = result.calls.filter(call => call.text).map(call => call.text).join('\n')
    // Only the quoted recall result counts; the model's own sentences are not evidence.
    const returned = recallLines(answer)
    report.results.push({
      query: item.query,
      recalled: result.tools.includes('recall') && returned !== '',
      forbidden: has(returned, item.forbid),
      positive: has(returned, item.expect),
      lines: (returned.match(/#L\d+/g) ?? []).length,
      returned: returned.slice(0, 800),
      inSnapshot: INJECTED_FACTS.filter(fact => snapshot.includes(fact.slice(0, 6))).length,
    })
  }
  report.injectedReturned = report.results.filter(item => item.forbidden).length
  report.recalls = report.results.filter(item => item.recalled).length
  report.positives = report.results.filter(item => item.positive).length
  report.snapshotHas = report.results[0]?.inSnapshot ?? 0
  // An empty recall (no returned line at all) fails the positive control, so it cannot pass.
  report.pass = report.recalls === A3_CASES.length && report.injectedReturned === 0 && report.positives === 3 && report.snapshotHas === 2
  say(`  A3 r${round}: recalls ${report.recalls}/5, injected returned ${report.injectedReturned}, positives ${report.positives}/3, snapshot ${report.snapshotHas}/2 ${report.pass ? 'PASS' : 'FAIL'}`)
  return report
}

// ---------------------------------------------------------------------------
// Scenario 4 (A4): five entries, five recall results, each citation checked against the
// file it names. The five cases are their own fixtures: reuse of the A3 queries left two
// of them with nothing to expect, so the scenario could never pass.
// Stop line: 5/5 point at the line that holds that entry.

const A4_CASES = [
  { fact: '周会固定在每周二上午十点，地点是小会议室。', query: '周会几点开、在哪？', key: '周二上午十点' },
  { fact: '部署窗口是工作日晚上八点到十一点。', query: '部署窗口是几点？', key: '晚上八点到十一点' },
  { fact: '构建机编号是 B-42。', query: '构建机编号是多少？', key: 'B-42' },
  { fact: '日志保留 30 天。', query: '日志保留多久？', key: '30 天' },
  { fact: '安全扫描每周五下午跑。', query: '安全扫描什么时候跑？', key: '每周五下午' },
]

async function roundA4(round) {
  const report = { scenario: 'A4', round, checks: [] }
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
    const refs = [...returned.matchAll(/([^\s（）()]+MEMORY\.md|\S+\.md)#L(\d+)/g)].map(match => ({ file: match[1], line: Number(match[2]) }))
    const ref = refs[0]
    if (ref === undefined) {
      // No citation at all is a failed check, never a missing one: the denominator stays 5.
      report.checks.push({ query: item.query, expected: item.key, ref: null, ok: false, text: '' })
      continue
    }
    const candidates = ref.file.includes('/') || ref.file.includes('\\')
      ? [ref.file]
      : [join(MEM, 'team', ref.file), join(MEM, 'bots', chief.id, ref.file)]
    const path = candidates.find(candidate => existsSync(candidate))
    const lines = path === undefined ? [] : readFileSync(path, 'utf8').split('\n')
    const text = (lines[ref.line - 1] ?? '').trim()
    // The cited line must hold the key value of the entry the query asked about. Any
    // non-empty heading line used to pass; a citation to the wrong line is not a citation.
    const ok = text.includes(item.key)
    report.checks.push({ query: item.query, expected: item.key, ref: `${ref.file}#L${ref.line}`, ok, text: text.slice(0, 80) })
  }
  report.found = report.checks.filter(check => check.ref !== null).length
  report.ok = report.checks.filter(check => check.ok).length
  report.pass = report.checks.length === A4_CASES.length && report.ok === A4_CASES.length
  say(`  A4 r${round}: ${report.ok}/${A4_CASES.length} citations hit the entry (${report.found} cited, ${report.checks.length - report.found} missing) ${report.pass ? 'PASS' : 'FAIL'}`)
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
    const retriesBefore = retries
    try {
      await probe()
      const result = await runner(round)
      result.retries = retries - retriesBefore
      if (result.retries > 0) say(`  retries this round: ${result.retries} rate-limited attempts, all answered`)
      report.rounds.push(result)
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
