// Vendors the Lucide icons the web portal uses (lucide-react, same version)
// into SVG files the native app loads as template images. Re-run after adding
// a case to LucideIcon: `bun scripts/vendor-icons.mjs` from packages/macos.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '../../../node_modules/lucide-react/dist/esm/icons')
const output = join(here, '../Sources/TaskSquad/Resources/Icons')
const names = [
  'inbox', 'monitor', 'file-text', 'repeat', 'layers', 'shield-alert', 'book-open', 'database', 'bot', 'users',
  'settings', 'book-marked', 'log-out', 'plus', 'refresh-cw', 'search', 'terminal', 'folder', 'x', 'play', 'square',
  'list-checks', 'scroll-text', 'file-cog', 'wrench', 'circle-alert', 'external-link', 'copy', 'check', 'paperclip',
  'message-square', 'messages-square', 'user', 'sparkles', 'zap', 'circle-check', 'circle', 'ellipsis', 'download',
  'clock', 'info', 'chevron-down', 'chevron-right', 'braces', 'network', 'circle-x', 'folder-plus', 'square-terminal',
  'triangle-alert', 'file-code', 'thumbs-up', 'thumbs-down', 'pencil', 'trash-2', 'send', 'laptop', 'sun', 'moon', 'sun-moon', 'chart-column',
]

const attributes = value => Object.entries(value).filter(([key]) => key !== 'key').map(([key, v]) => `${key}="${v}"`).join(' ')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
for (const name of names) {
  const text = readFileSync(join(source, `${name}.js`), 'utf8')
  const match = text.match(/const __iconNode = (\[[\s\S]*?\]);\n/)
  if (!match) throw new Error(`No icon node in ${name}.js`)
  const nodes = Function(`return ${match[1]}`)()
  const body = nodes.map(([tag, attrs]) => `  <${tag} ${attributes(attrs)}/>`).join('\n')
  writeFileSync(join(output, `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>\n`)
}
console.log(`Wrote ${names.length} icons to ${output}`)
