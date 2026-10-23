// Puts a "Manga Index" shortcut on the Windows desktop that opens the app as last built (npm run build),
// without a terminal: Electron itself, pointed at this folder. Run with: npm run shortcut
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electron)) throw new Error('Electron não encontrado: rode npm install primeiro.')
if (!existsSync(join(root, 'out', 'main', 'index.js'))) throw new Error('O app ainda não foi compilado: rode npm run build primeiro.')

const quote = (s) => `'${s.replace(/'/g, "''")}'`
const script = `
$desktop = [Environment]::GetFolderPath('Desktop')
$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Manga Index.lnk'))
$link.TargetPath = ${quote(electron)}
$link.Arguments = '"' + ${quote(root)} + '"'
$link.WorkingDirectory = ${quote(root)}
$link.IconLocation = ${quote(join(root, 'build', 'icon.ico'))}
$link.Description = 'Manga Index'
$link.Save()
Write-Output (Join-Path $desktop 'Manga Index.lnk')
`
console.log(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim())
