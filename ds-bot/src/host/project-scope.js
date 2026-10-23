// Project identity: which folder a Session's memory belongs to. A project is the
// nearest Git repository above the Session's working folder — its common dir, so
// every worktree of one repository is one project while a submodule, whose common
// dir differs, is its own. Without Git, the nearest folder with a project marker
// (package.json and the like) is the project; a folder with neither is its own
// project, except the team workspace itself, which is the group folder and not a
// project. One resolver serves reads, writes, prompts, and the panel: a second
// algorithm would let two callers disagree about the same folder.
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Nothing here outlives the process; a wrong answer (a missing .git, a moved
// folder) must not either, so even a clean "ok" expires. A caller that needs one
// answer for one operation reads the resolver once and keeps the result.
const CACHE_MS = 10_000
const MARKER_FILES = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml']

// realpathSync.native on Windows hands back a `\\?\` extended path when the input
// was one, and plain paths otherwise. The prefix is not part of the path's name:
// strip it, keeping UNC distinct, so both spellings of one folder are one key.
function plain(path) {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`
  if (path.startsWith('\\\\?\\')) return path.slice(4)
  return path
}

const real = (path) => {
  try {
    return plain(realpathSync.native(path))
  } catch {
    return undefined
  }
}

function identityOf(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

const isThere = (path) => {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

// The first line of a small text file, the way Git's pointers are laid out. A
// missing file is the caller's business; anything unreadable is a broken
// repository, which is "unresolved", not "no project".
function firstLine(path) {
  const file = statSync(path)
  if (!file.isFile()) throw new Error(`${path} is not a file`)
  const buffer = Buffer.alloc(Math.min(file.size, 4096))
  const handle = openSync(path, 'r')
  try {
    readSync(handle, buffer, 0, buffer.length, 0)
  } finally {
    closeSync(handle)
  }
  const line = buffer.toString('utf8').split(/\r?\n/, 1)[0] ?? ''
  const pointed = /^gitdir:\s*(\S.*?)\s*$/.exec(line)
  return { line, pointed }
}

// Nearest Git identity above `cwd`: the real path of the .git directory, or of the
// common dir a linked worktree's pointer leads to. `undefined` means no Git at all.
function nearestGit(cwd) {
  let current = cwd
  for (;;) {
    const dot = join(current, '.git')
    let info
    try {
      info = statSync(dot)
    } catch (error) {
      if (error?.code !== 'ENOENT') return { error: `cannot look at ${dot}: ${error?.message ?? error}` }
    }
    if (info !== undefined) {
      if (info.isDirectory()) {
        const dir = real(dot)
        return dir === undefined ? { error: `cannot resolve ${dot}` } : { identity: dir }
      }
      if (!info.isFile()) return { error: `${dot} is neither a directory nor a gitdir pointer` }
      let head
      try {
        head = firstLine(dot)
      } catch (error) {
        return { error: `cannot read ${dot}: ${error?.message ?? error}` }
      }
      if (head.pointed === null) return { error: `${dot} does not hold a gitdir pointer` }
      // The pointer's path is absolute or relative to the folder holding the file.
      const gitdir = resolve(dirname(dot), head.pointed[1].replace(/^"|"$/g, ''))
      if (!isThere(gitdir)) return { error: `${dot} points at ${gitdir}, which is not there` }
      // A linked worktree's gitdir holds commondir; a submodule's does not, and its
      // gitdir (inside the parent's .git/modules) is its identity: the submodule is
      // its own project, never folded into the parent by guessing from the path.
      const common = join(gitdir, 'commondir')
      let identity = gitdir
      if (isThere(common)) {
        let text
        try {
          text = firstLine(common)
        } catch (error) {
          return { error: `cannot read ${common}: ${error?.message ?? error}` }
        }
        const pointed2 = text.line.trim()
        if (pointed2 === '') return { error: `${common} is empty` }
        identity = resolve(gitdir, pointed2.replace(/^"|"$/g, ''))
        if (!isThere(identity)) return { error: `${common} points at ${identity}, which is not there` }
      }
      const dir = real(identity)
      return dir === undefined ? { error: `cannot resolve ${identity}` } : { identity: dir }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

const markerIn = (dir) => {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  return names.some(name => MARKER_FILES.includes(name) || name.endsWith('.csproj'))
}

export function makeResolver({ teamFolder } = {}) {
  /** @type {Map<string, {at: number, result: object}>} */
  const cache = new Map()
  const clear = () => cache.clear()
  const team = () => {
    const folder = teamFolder?.()
    return folder === undefined ? undefined : real(folder) ?? plain(folder)
  }

  function resolve(input) {
    const key = String(input ?? '')
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.result
    const result = compute(key)
    cache.set(key, { at: Date.now(), result })
    return result
  }

  function compute(cwd) {
    if (cwd === '') return { status: 'unresolved', reason: 'no working folder' }
    const realCwd = real(cwd)
    if (realCwd === undefined) return { status: 'unresolved', reason: `there is no folder at ${cwd}` }
    const home = team()
    const atHome = () => home !== undefined && realCwd === home

    const git = nearestGit(realCwd)
    if (git?.error !== undefined) return { status: 'unresolved', reason: git.error }
    // The Git search does not stop at the team folder: a Session in a subfolder of
    // a repository still belongs to the repository, and the team workspace itself
    // often is one (the single-repo install).
    if (git !== undefined) return { status: 'ok', root: git.identity, kind: 'git' }

    // The marker walk does stop there: the group folder holds several projects,
    // and a stray marker above it would swallow them all.
    let current = realCwd
    for (;;) {
      if (markerIn(current)) return { status: 'ok', root: current, kind: 'marker' }
      if (home !== undefined && current === home) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    // Below or at the team workspace with no Git and no marker: the workspace is
    // the group folder, not a project. Anywhere else, the folder stands on its own.
    if (atHome()) return { status: 'none' }
    return { status: 'ok', root: realCwd, kind: 'self' }
  }

  return { resolve, clear }
}

export function install(rt) {
  const memoryRoot = join(rt.home, 'memory')
  const projectsDir = join(memoryRoot, 'projects')
  const registryPath = join(memoryRoot, 'projects.json')

  const resolver = makeResolver({ teamFolder: () => rt.teamFolder?.() })

  let registry
  const registryNow = () => {
    if (registry === undefined) {
      try {
        const value = JSON.parse(readFileSync(registryPath, 'utf8'))
        registry = value !== null && typeof value === 'object' ? value : {}
      } catch {
        registry = {}
      }
    }
    return registry
  }
  const saveRegistry = () => {
    try {
      mkdirSync(memoryRoot, { recursive: true })
      writeFileSync(registryPath, JSON.stringify(registryNow(), null, 2))
    } catch (error) {
      rt.warn?.('ds-bot: project registry not saved: %s', error?.message ?? error)
    }
  }

  // The registry is for people and for collision checks; it takes no part in
  // deciding a folder's identity. A hash that lands on a second path is refused,
  // not merged: two projects never share memory on a coincidence.
  function register(result) {
    const known = registryNow()[result.hash]
    if (known !== undefined && known.path !== result.root) {
      return `project id ${result.hash} already belongs to ${known.path}, not ${result.root}; refusing to share memory between them`
    }
    if (known === undefined) {
      registryNow()[result.hash] = { path: result.root, kind: result.kind, at: new Date().toISOString() }
      saveRegistry()
    }
    return undefined
  }

  // One folder's identity through the same resolver every other consumer uses. A task
  // candidate keeps the folder it was reported in; when its project could not be told
  // apart then, this is what re-reads that folder — never another Session's.
  function resolveCwd(cwd) {
    if (rt.config.projectMemory === false) return { status: 'off' }
    if (cwd === undefined || cwd === null) return { status: 'none' }
    const resolved = resolver.resolve(cwd)
    if (resolved.status !== 'ok') return resolved
    const hash = identityOf(resolved.root)
    const clash = register({ hash, root: resolved.root, kind: resolved.kind })
    if (clash !== undefined) return { status: 'unresolved', reason: clash }
    return { ...resolved, hash, scope: { kind: 'project', hash, root: resolved.root } }
  }

  // Every consumer goes through here: the Session's working folder, as DSH sees
  // it, and no other source of a cwd.
  function projectOf(session) {
    if (rt.config.projectMemory === false) return { status: 'off' }
    const cwd = rt.sessionFolder?.(session)
    if (cwd === undefined) return { status: 'none' }
    return resolveCwd(cwd)
  }

  Object.assign(rt, {
    projectScope: {
      resolve: projectOf,
      resolveCwd,
      dirOf: scope => join(projectsDir, scope.hash),
      clearCache: resolver.clear,
      projectsDir,
      registryPath,
    },
  })
}
