/** Rebuildable heap: durable assignments remain the authority. Positive means higher priority. */
export class MaxHeap<T> {
  private values: T[] = []
  constructor(private compare: (a: T, b: T) => number) {}
  get size(): number {
    return this.values.length
  }
  push(value: T): void {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.compare(this.values[index], this.values[parent]) <= 0) break
      ;[this.values[index], this.values[parent]] = [this.values[parent], this.values[index]]
      index = parent
    }
  }
  pop(): T | undefined {
    if (!this.size) return undefined
    const top = this.values[0],
      last = this.values.pop()!
    if (this.size) {
      this.values[0] = last
      this.down(0)
    }
    return top
  }
  popLowest(): T | undefined {
    if (!this.size) return undefined
    let lowest = 0
    for (let i = 1; i < this.size; i++) if (this.compare(this.values[i], this.values[lowest]) < 0) lowest = i
    const selected = this.values[lowest],
      remaining = this.values.filter((_, i) => i !== lowest)
    this.values = []
    for (const value of remaining) this.push(value)
    return selected
  }
  private down(index: number): void {
    while (true) {
      let best = index
      for (const child of [2 * index + 1, 2 * index + 2])
        if (child < this.size && this.compare(this.values[child], this.values[best]) > 0) best = child
      if (best === index) return
      ;[this.values[index], this.values[best]] = [this.values[best], this.values[index]]
      index = best
    }
  }
}
