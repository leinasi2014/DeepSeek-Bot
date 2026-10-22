import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, mock, test } from 'node:test'
import { fakeContext } from './fake-ctx.js'

// Deny only directory enumeration, while the existing files remain readable and
// writable. Filesystem permissions cannot express that consistently across platforms.
let denied
const { default: fsDefault, ...fsNamed } = fs
mock.module('node:fs', {
  defaultExport: { ...fsDefault },
  namedExports: {
    ...fsNamed,
    readdirSync(path, ...args) {
      if (denied !== undefined && resolve(path) === denied.path) {
        throw Object.assign(new Error(`${denied.code}: directory enumeration failed`), { code: denied.code })
      }
      return fs.readdirSync(path, ...args)
    },
  },
})
const { install } = await import('../src/host/memory.js')
after(() => mock.reset())

function start(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-memory-directory-'))
  const ctx = fakeContext()
  const bot = { id: 'chief', name: 'Chief' }
  install({
    ctx, home, config: { memoryReview: false }, state: { rooms: {} },
    load: async () => {}, botOf: id => id === bot.id ? bot : undefined,
    selfOf: id => id, isMain: id => id === bot.id,
    readOnly: () => undefined, warn() {}, groupOwners: new Map(),
    partsOf: () => [{ sessionId: bot.id }],
    async* eventsBackwards() {}, clock: () => '12:00',
  })
  t.after(async () => {
    denied = undefined
    await ctx.dispose()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const remember = args => ctx.registeredTools.get('remember').execute(args, { agent: { id: bot.id } })
  return { home, remember }
}

for (const scope of ['own', 'team']) {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    test(`${scope} memory is unchanged when directory enumeration fails with ${code}`, async (t) => {
      const { home, remember } = start(t)
      const dir = join(home, 'memory', ...(scope === 'team' ? ['team'] : ['bots', 'chief']))
      const paths = [join(dir, 'ops.md'), join(dir, 'MEMORY.md'), join(home, 'memory', 'journal.jsonl')]
      assert.match(await remember({ scope, topic: 'ops', text: 'Keep the existing deployment rule' }), /^Saved/)
      const before = paths.map(path => fs.readFileSync(path, 'utf8'))

      denied = { path: resolve(dir), code }
      const result = await remember({ scope, topic: 'ops', text: 'Add the new deployment rule' })
      assert.match(result, new RegExp(code), 'the write reports the directory error')
      assert.deepEqual(paths.map(path => fs.readFileSync(path, 'utf8')), before, 'topic, index and journal are unchanged')

      denied = undefined
      assert.match(await remember({ scope, topic: 'ops', text: 'Add the new deployment rule' }), /^Saved/)
      const topic = fs.readFileSync(paths[0], 'utf8')
      assert.match(topic, /Keep the existing deployment rule/)
      assert.match(topic, /Add the new deployment rule/)
    })
  }
}

test('a missing memory directory is empty and the first save creates it', async (t) => {
  const { home, remember } = start(t)
  assert.match(await remember({ topic: 'ops', text: 'The first deployment rule' }), /^Saved/)
  assert.match(fs.readFileSync(join(home, 'memory', 'bots', 'chief', 'ops.md'), 'utf8'), /The first deployment rule/)
})
