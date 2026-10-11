import { describe, expect, it } from 'vitest'
import { inputFrame, stripAnsi } from './terminal.js'

describe('terminal helpers', () => {
  it('strips ANSI colour, cursor and OSC sequences', () => {
    const raw = '\x1b]0;title\x07\x1b[1;32mok\x1b[0m done\r\n\x1b[2K\x1b[1Gnext\x1b(B'
    expect(stripAnsi(raw)).toBe('ok done\nnext')
  })

  it('encodes input frames like the web LiveTerminal (base64 of UTF-8)', () => {
    const frame = JSON.parse(new TextDecoder().decode(inputFrame('é猫\r')))
    expect(frame.t).toBe('i')
    const bytes = Uint8Array.from(atob(frame.d), c => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe('é猫\r')
  })
})
