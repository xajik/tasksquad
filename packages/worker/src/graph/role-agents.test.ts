import { describe, it, expect } from 'vitest'
import { templates } from './contracts.js'
import roleAgents from './role-agents.json'

// The Go daemon and Swift engine pick a sub-agent identity per role; role-agents.json is the shared table.
describe('role to sub-agent table', () => {
  it('covers every graph role exactly once', () => {
    expect(Object.keys(roleAgents).sort()).toEqual([...Object.keys(templates), 'repair'].sort())
  })
})
