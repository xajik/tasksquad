import { describe, it, expect } from 'vitest'
import { priority } from './priority.js'
import { MaxHeap } from './heap.js'

describe('graph scheduling', () => {
  it('orders the heap and preserves remaining work after a bounded weak trial', () => {
    const heap = new MaxHeap<number>((a, b) => a - b)
    for (const value of [4, 1, 6, 3, 2, 5]) heap.push(value)
    expect(heap.pop()).toBe(6)
    expect(heap.popLowest()).toBe(1)
    expect([heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual([5, 4, 3, 2])
    expect(heap.pop()).toBeUndefined()
  })
  it('reduces priority after a downward regrade and discounts stale evidence', () => {
    const base = { local: 0.8, goal: 0.8, visits: 1, observedAt: 1000, now: 1000, recovery: false }
    expect(priority({ ...base, local: 0.2, goal: 0.2 })).toBeLessThan(priority(base))
    expect(priority({ ...base, now: 864001000 })).toBeLessThan(priority(base))
    expect(priority({ ...base, recovery: true })).toBeGreaterThan(priority(base))
  })
})
