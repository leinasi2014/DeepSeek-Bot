import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install, makeResolver } from '../src/host/project-scope.js'

const temp = mkdtempSync(join(tmpdir(), 'ds-bot-project-scope-'))
after(() => rmSync(temp, { recursive: true, force: true }))

const folder = (name) => {
  const path = join(temp, name)
  mkdirSync(path, { recursive: true })
  return path
}
// The resolver returns native real paths, so every expected path goes through
// the same view before they are compared: a symlinked temp folder (some Linux
// runners) or an 8.3 short name (Windows) would otherwise make a correct
// answer look wrong.
const real = path => realpathSync.native(path)
const file = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

test('a plain repository is one project from any folder inside it', () => {
  const resolve = makeResolver().resolve
  const repo = folder('repo')
  mkdirSync(join(repo, '.git'))
  file(join(repo, 'sub', 'deep', 'note.txt'), '')
  const root = resolve(repo)
  assert.equal(root.status, 'ok')
  assert.equal(root.kind, 'git')
  assert.equal(resolve(join(repo, 'sub', 'deep')).root, root.root)
})

test('a worktree of a repository shares its identity, a submodule does not', () => {
  const resolve = makeResolver().resolve
  const repo = folder('wt-repo')
  const git = join(repo, '.git')
  mkdirSync(join(git, 'objects'), { recursive: true })
  const work = folder('wt-work')
  // The worktree pointer and its gitdir, laid out as Git lays them out: commondir
  // in the gitdir points back at the repository's .git.
  file(join(work, '.git'), `gitdir: ${join(git, 'worktrees', 'wt')}\n`)
  file(join(git, 'worktrees', 'wt', 'commondir'), '../..\n')
  const sub = folder('wt-sub')
  // A submodule: the pointer names the parent's modules folder, which holds no
  // commondir, so the gitdir itself is the identity — never the parent's .git.
  file(join(sub, '.git'), `gitdir: ${join(git, 'modules', 'sub')}\n`)
  mkdirSync(join(git, 'modules', 'sub'), { recursive: true })
  assert.equal(resolve(work).root, resolve(repo).root)
  assert.notEqual(resolve(sub).root, resolve(repo).root)
})

test('a relative gitdir pointer resolves against the folder holding the .git file', () => {
  const resolve = makeResolver().resolve
  const repo = folder('rel-repo')
  mkdirSync(join(repo, '.git'))
  const work = folder('rel-work')
  file(join(work, '.git'), 'gitdir: ../rel-repo/.git/worktrees/w\n')
  file(join(repo, '.git', 'worktrees', 'w', 'commondir'), '../..\n')
  assert.equal(resolve(work).root, resolve(repo).root)
})

test('a broken gitdir pointer is unresolved, not absent', () => {
  const resolve = makeResolver().resolve
  const broken = folder('broken')
  file(join(broken, '.git'), 'gitdir: ../nowhere\n')
  assert.equal(resolve(broken).status, 'unresolved')
  const garbage = folder('garbage')
  file(join(garbage, '.git'), 'not a pointer\n')
  assert.equal(resolve(garbage).status, 'unresolved')
})

test('markers name the project when there is no Git, from any depth', () => {
  const resolve = makeResolver().resolve
  const project = folder('marked')
  file(join(project, 'package.json'), '{}')
  file(join(project, 'a', 'b', 'c', 'd', 'e', 'leaf.txt'), '')
  const found = resolve(join(project, 'a', 'b', 'c', 'd', 'e'))
  assert.equal(found.status, 'ok')
  assert.equal(found.kind, 'marker')
  assert.equal(found.root, resolve(project).root)
})

test('Git wins over a package.json on the way up', () => {
  const resolve = makeResolver().resolve
  const repo = folder('monorepo')
  mkdirSync(join(repo, '.git'))
  file(join(repo, 'packages', 'a', 'package.json'), '{}')
  const found = resolve(join(repo, 'packages', 'a'))
  assert.equal(found.kind, 'git')
  assert.equal(found.root, resolve(repo).root)
})

test('the team workspace with nothing in it is no project; a folder of its own is one', () => {
  const team = folder('team')
  const resolve = makeResolver({ teamFolder: () => team }).resolve
  assert.equal(resolve(team).status, 'none')
  // Below the team folder, the marker walk stops at the team folder: no marker
  // there means the folder stands on its own, not that the walk goes above.
  const notes = folder(join('team', 'plain', 'notes'))
  const found = resolve(notes)
  assert.equal(found.status, 'ok')
  assert.equal(found.kind, 'self')
  assert.equal(found.root, real(notes))
})

test('the team workspace that is a repository is a project', () => {
  const team = folder('team-repo')
  mkdirSync(join(team, '.git'))
  folder(join('team-repo', 'ds-bot'))
  const resolve = makeResolver({ teamFolder: () => team }).resolve
  const found = resolve(join(team, 'ds-bot'))
  assert.equal(found.status, 'ok')
  assert.equal(found.kind, 'git')
  assert.equal(found.root, resolve(team).root)
})

test('a marker above the team folder does not swallow folders below it', () => {
  const team = folder('team-marked')
  file(join(team, 'project-a', 'package.json'), '{}')
  const resolve = makeResolver({ teamFolder: () => team }).resolve
  const other = folder(join('team-marked', 'project-b'))
  assert.equal(resolve(other).root, real(other))
})

test('a missing folder is unresolved and the case of a folder is the case on disk', () => {
  const resolve = makeResolver().resolve
  assert.equal(resolve(join(temp, 'not-there')).status, 'unresolved')
  const lower = folder('casetest')
  // A case-insensitive filesystem (Windows, macOS) answers both spellings with
  // the name on disk, so both are one project; a case-sensitive one (Linux CI)
  // answers that the other spelling is not there. Both keep the real case,
  // each in its own way, so the assertion follows the filesystem at hand.
  const upper = join(dirname(lower), 'CASETEST')
  if (existsSync(upper)) {
    assert.equal(resolve(upper).root, real(lower))
    assert.equal(resolve(upper).root, resolve(lower).root)
  } else {
    assert.equal(resolve(upper).status, 'unresolved')
    assert.equal(resolve(lower).root, real(lower))
    assert.equal(resolve(lower).root, resolve(lower).root)
  }
})

test('answers expire, so a folder that gains a repository is found again', () => {
  const made = makeResolver()
  const target = folder('late-git')
  file(join(target, 'package.json'), '{}')
  assert.equal(made.resolve(target).kind, 'marker')
  mkdirSync(join(target, '.git'))
  assert.equal(made.resolve(target).kind, 'marker', 'still cached')
  made.clear()
  assert.equal(made.resolve(target).kind, 'git')
})

test('the session scope serves reads and writes, and refuses a hash collision', async t => {
  const ctx = fakeContext()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-project-scope-rt-'))
  const sessions = { s1: { id: 's1', header: { cwd: join(temp, 'repo') } } }
  const rt = {
    ctx, home, config: {}, warn: () => {},
    teamFolder: () => join(temp, 'team-none'),
    sessionFolder: session => sessions[session?.id ?? session]?.header?.cwd,
  }
  install(rt)
  t.after(() => { rmSync(home, { recursive: true, force: true }); return ctx.dispose() })
  const project = rt.projectScope.resolve('s1')
  assert.equal(project.status, 'ok')
  assert.match(project.scope.hash, /^[0-9a-f]{16}$/)
  assert.equal(rt.projectScope.dirOf(project.scope), join(home, 'memory', 'projects', project.scope.hash))
  // off by config
  rt.config.projectMemory = false
  assert.equal(rt.projectScope.resolve('s1').status, 'off')
  rt.config.projectMemory = undefined
  // a session the resolver does not know
  assert.equal(rt.projectScope.resolve('nope').status, 'none')
  // a hash that already belongs to another path is refused, not merged; a second
  // install reads the registry from disk, so the tampered entry is seen
  const registry = JSON.parse(readFileSync(join(home, 'memory', 'projects.json'), 'utf8'))
  registry[project.scope.hash] = { path: 'D:\\elsewhere', at: '2026-10-22T00:00:00Z' }
  writeFileSync(join(home, 'memory', 'projects.json'), JSON.stringify(registry))
  const rt2 = { ctx: fakeContext(), home, config: {}, warn: () => {}, teamFolder: rt.teamFolder, sessionFolder: rt.sessionFolder }
  install(rt2)
  const clash = rt2.projectScope.resolve('s1')
  assert.equal(clash.status, 'unresolved')
  assert.match(clash.reason, /refusing to share memory/)
})
