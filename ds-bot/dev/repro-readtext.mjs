// Reproduces the 0.1.7 readText bug without touching real memory: a MEMORY.md that
// cannot be read (non-ENOENT) is treated as an empty file, so the next write rebuilds it
// from EMPTY_MAIN and every old entry is gone.
//
//   node dev/repro-readtext.mjs [dir]
//
// The directory defaults to a scratch dir under the OS temp dir. Nothing outside it is
// touched, and the deny rule it adds is removed again before exiting.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'repro-readtext-'))
mkdirSync(root, { recursive: true })
const file = join(root, 'MEMORY.md')
const EMPTY_MAIN = '# Memory\n\n## Index\n'
const SAMPLE = `${EMPTY_MAIN}- 第一条：周会固定在周二上午十点。\n- 第二条：部署窗口是工作日晚上。\n- 第三条：日志保留 30 天。\n`

writeFileSync(file, SAMPLE, 'utf8')
const lines = text => text.split('\n').filter(Boolean).length
const before = lines(readFileSync(file, 'utf8'))

// Make the file readable by nobody in this user's context: readFileSync now throws EACCES.
const user = process.env.USERNAME ?? process.env.USER ?? ''
execFileSync('icacls', [file, '/deny', `${user}:R`], { stdio: 'ignore' })

let error
let fallback
try {
  fallback = readFileSync(file, 'utf8')
} catch (caught) {
  error = caught
  // What readText does today: any error that is not ENOENT still yields ''.
  fallback = caught.code === 'ENOENT' ? '' : ''
}

// The write path then rebuilds from EMPTY_MAIN, because the scope looked empty. The deny
// rule is lifted first: on Windows a read-deny also makes the open for writing fail with
// EPERM, which would hide the code path this script is about.
execFileSync('icacls', [file, '/remove:d', user], { stdio: 'ignore' })
const rebuilt = fallback.trim() === '' ? `${EMPTY_MAIN}- 第四条：新写的一条。\n` : fallback
writeFileSync(file, rebuilt, 'utf8')

const after = lines(readFileSync(file, 'utf8'))
console.log(`dir            ${root}`)
console.log(`read error     ${error ? `${error.code}: ${error.message.split('\n')[0]}` : 'none'}`)
console.log(`main lines     ${before} -> ${after}`)
console.log(`entries kept   ${after >= before ? 'yes' : 'NO — old entries were overwritten'}`)
console.log(`size           ${statSync(file).size} B`)
if (after < before) console.log('REPRODUCED')
else { console.log('NOT REPRODUCED'); process.exitCode = 1 }
if (process.argv[2] === undefined) rmSync(root, { recursive: true, force: true })
