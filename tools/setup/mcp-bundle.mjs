#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.argv[2] || process.cwd(), '.mcp.json')

const BUNDLE = {
  playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
}

let doc = { mcpServers: {} }
if (existsSync(target)) {
  try {
    doc = JSON.parse(readFileSync(target, 'utf8'))
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      throw new Error('корень не объект')
    }
  } catch (e) {
    console.warn(`[mcp-bundle] ${target} не распарсился (${e.message}) — файл не тронут, выхожу без изменений.`)
    process.exit(0)
  }
}
doc.mcpServers ??= {}

const added = []
for (const [name, cfg] of Object.entries(BUNDLE)) {
  if (!doc.mcpServers[name]) {
    doc.mcpServers[name] = cfg
    added.push(name)
  }
}

if (added.length === 0) {
  console.log('[mcp-bundle] playwright и context7 уже подключены — изменений нет.')
  process.exit(0)
}

writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', 'utf8')
console.log(`[mcp-bundle] добавлены серверы: ${added.join(', ')} → ${target}`)
