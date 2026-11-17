// Puts the phone app just built (flutter build apk) where the PC app hands it to the phones, with its
// version from mobile/pubspec.yaml: phones on an older build offer to update when opened.
// Run after building the APK: node scripts/phone-release.mjs
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..', 'mobile')
const built = join(mobile, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk')
if (!existsSync(built)) throw new Error('APK não encontrado: rode flutter build apk primeiro.')
const found = /^version:\s*([\d.]+)\+(\d+)/m.exec(readFileSync(join(mobile, 'pubspec.yaml'), 'utf8'))
if (!found) throw new Error('Versão não encontrada em mobile/pubspec.yaml.')

copyFileSync(built, join(mobile, 'build', 'MangaIndex.apk'))
const release = { version: found[1], build: Number(found[2]), at: Date.now() }
writeFileSync(join(mobile, 'build', 'MangaIndex.json'), JSON.stringify(release, null, 2))
console.log(`MangaIndex.apk ${release.version} (build ${release.build})`)
