/** Deterministic layered packing and obstacle-aware orthogonal edge routing. */
export interface Point {
  x: number
  y: number
}
export interface Box extends Point {
  width: number
  height: number
}
export interface LayoutNode {
  id: string
  kind: string
  created_at: number
}
export interface LayoutEdge {
  id: string
  from_id: string
  to_id: string
  lineage?: boolean
}
export const NODE_WIDTH = 220
export const NODE_HEIGHT = 76
const PAD = 14
export const isGuidance = (node: { kind: string }) => ['goal', 'milestone'].includes(node.kind)
const expanded = (b: Box, pad = PAD): Box => ({
  x: b.x - pad,
  y: b.y - pad,
  width: b.width + pad * 2,
  height: b.height + pad * 2
})
export function intersects(a: Box, b: Box) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}
export function segmentHits(a: Point, b: Point, box: Box) {
  if (a.x === b.x)
    return (
      a.x > box.x &&
      a.x < box.x + box.width &&
      Math.max(a.y, b.y) > box.y &&
      Math.min(a.y, b.y) < box.y + box.height
    )
  return (
    a.y > box.y &&
    a.y < box.y + box.height &&
    Math.max(a.x, b.x) > box.x &&
    Math.min(a.x, b.x) < box.x + box.width
  )
}

function route(start: Point, end: Point, obstacles: Box[], bounds: Box, occupied: Set<string>) {
  const xs = [
    ...new Set([
      bounds.x,
      bounds.x + bounds.width,
      start.x,
      end.x,
      ...obstacles.flatMap((b) => [b.x, b.x + b.width])
    ])
  ].sort((a, b) => a - b)
  const ys = [
    ...new Set([
      bounds.y,
      bounds.y + bounds.height,
      start.y,
      end.y,
      ...obstacles.flatMap((b) => [b.y, b.y + b.height])
    ])
  ].sort((a, b) => a - b)
  const width = xs.length,
    point = (i: number) => ({ x: xs[i % width], y: ys[Math.floor(i / width)] })
  const begin = ys.indexOf(start.y) * width + xs.indexOf(start.x),
    goal = ys.indexOf(end.y) * width + xs.indexOf(end.x)
  const distance = new Map<number, number>([[begin, 0]]),
    previous = new Map<number, number>()
  // A binary heap keeps dense fan-outs responsive; no graph-layout dependency.
  const heap: { id: number; score: number }[] = []
  function push(item: { id: number; score: number }) {
    let i = heap.length
    heap.push(item)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent].score <= item.score) break
      heap[i] = heap[parent]
      i = parent
    }
    heap[i] = item
  }
  function pop() {
    const top = heap[0],
      last = heap.pop()!
    if (heap.length) {
      let i = 0
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1
        if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++
        if (heap[child].score >= last.score) break
        heap[i] = heap[child]
        i = child
      }
      heap[i] = last
    }
    return top
  }
  const heuristic = (p: Point) => Math.abs(p.x - end.x) + Math.abs(p.y - end.y)
  push({ id: begin, score: heuristic(start) })
  const closed = new Set<number>()
  while (heap.length) {
    const { id } = pop()
    if (closed.has(id)) continue
    if (id === goal) {
      const points: Point[] = []
      let current: number | undefined = id
      while (current !== undefined) {
        points.push(point(current))
        current = previous.get(current)
      }
      return points.reverse()
    }
    closed.add(id)
    const p = point(id),
      col = id % width,
      row = Math.floor(id / width)
    for (const next of [
      col > 0 ? id - 1 : -1,
      col < width - 1 ? id + 1 : -1,
      row > 0 ? id - width : -1,
      row < ys.length - 1 ? id + width : -1
    ]) {
      if (next < 0 || closed.has(next)) continue
      const q = point(next)
      if (obstacles.some((box) => segmentHits(p, q, box))) continue
      const key = [p.x, p.y, q.x, q.y].join(',')
      const reverse = [q.x, q.y, p.x, p.y].join(',')
      const cost =
        distance.get(id)! +
        Math.abs(p.x - q.x) +
        Math.abs(p.y - q.y) +
        (occupied.has(key) || occupied.has(reverse) ? 80 : 0)
      if (cost >= (distance.get(next) ?? Infinity)) continue
      distance.set(next, cost)
      previous.set(next, id)
      push({ id: next, score: cost + heuristic(q) })
    }
  }
  throw new Error('Unable to route graph edge around obstacles')
}

export function layoutGraph(allNodes: LayoutNode[], allEdges: LayoutEdge[], includeGuidance = false) {
  const nodes = allNodes
    .filter((n) => includeGuidance || !isGuidance(n))
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  const ids = new Set(nodes.map((n) => n.id)),
    edges = allEdges
      .filter((e) => ids.has(e.from_id) && ids.has(e.to_id))
      .sort((a, b) => a.id.localeCompare(b.id))
  const neighbors = new Map(nodes.map((n) => [n.id, new Set<string>()]))
  const outgoing = new Map(nodes.map((n) => [n.id, [] as string[]]))
  const incoming = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    neighbors.get(e.from_id)!.add(e.to_id)
    neighbors.get(e.to_id)!.add(e.from_id)
    outgoing.get(e.from_id)!.push(e.to_id)
    incoming.set(e.to_id, incoming.get(e.to_id)! + 1)
  }
  const positions = new Map<string, Box>(),
    visited = new Set<string>()
  let top = 48
  for (const first of nodes) {
    if (visited.has(first.id)) continue
    const component: string[] = [],
      pending = [first.id]
    visited.add(first.id)
    while (pending.length) {
      const id = pending.shift()!
      component.push(id)
      for (const next of neighbors.get(id)!)
        if (!visited.has(next)) {
          visited.add(next)
          pending.push(next)
        }
    }
    const ranks = new Map<string, number>()
    let roots = component.filter((id) => incoming.get(id) === 0)
    if (!roots.length)
      roots = [component.find((id) => nodes.find((n) => n.id === id)?.kind === 'observed') ?? component[0]]
    const queue = [...roots]
    roots.forEach((id) => ranks.set(id, 0))
    while (queue.length) {
      const id = queue.shift()!
      for (const next of outgoing.get(id)!)
        if (!ranks.has(next)) {
          ranks.set(next, ranks.get(id)! + 1)
          queue.push(next)
        }
    }
    // Disconnected direction / cycle entry points still pack into unique slots.
    for (const id of component) if (!ranks.has(id)) ranks.set(id, 0)
    const columns = new Map<number, string[]>()
    for (const id of component) {
      const rank = ranks.get(id)!
      columns.set(rank, [...(columns.get(rank) ?? []), id])
    }
    const rows = Math.max(...[...columns.values()].map((col) => col.length))
    for (const [rank, column] of columns)
      column.forEach((id, row) =>
        positions.set(id, {
          x: 48 + rank * 380,
          y: top + row * 140 + (rows - column.length) * 70,
          width: NODE_WIDTH,
          height: NODE_HEIGHT
        })
      )
    top += rows * 140 + 64
  }
  const nodeBoxes = [...positions.values()],
    obstacleBoxes = nodeBoxes.map((b) => expanded(b))
  const maxX = Math.max(480, ...nodeBoxes.map((b) => b.x + b.width)),
    maxY = Math.max(220, ...nodeBoxes.map((b) => b.y + b.height))
  const routed = new Map<string, { points: Point[]; label: Box | null }>(),
    labels: Box[] = [],
    occupied = new Set<string>()
  const sourceGroups = new Map<string, LayoutEdge[]>(),
    targetGroups = new Map<string, LayoutEdge[]>()
  for (const e of edges) {
    sourceGroups.set(e.from_id, [...(sourceGroups.get(e.from_id) ?? []), e])
    targetGroups.set(e.to_id, [...(targetGroups.get(e.to_id) ?? []), e])
  }
  const portY = (box: Box, group: LayoutEdge[], edge: LayoutEdge) =>
    box.y + 18 + ((group.indexOf(edge) + 1) * (NODE_HEIGHT - 36)) / (group.length + 1)
  edges.forEach((edge, index) => {
    const a = positions.get(edge.from_id)!,
      b = positions.get(edge.to_id)!
    const start = { x: a.x + a.width + PAD, y: portY(a, sourceGroups.get(edge.from_id)!, edge) }
    const end = { x: b.x - PAD, y: portY(b, targetGroups.get(edge.to_id)!, edge) }
    const lane = 24 + index * 10
    const path = route(
      start,
      end,
      [...obstacleBoxes, ...labels.map((b) => expanded(b, 6))],
      { x: -lane, y: -lane, width: maxX + lane * 2 + 48, height: maxY + lane * 2 + 48 },
      occupied
    )
    for (let i = 1; i < path.length; i++)
      occupied.add([path[i - 1].x, path[i - 1].y, path[i].x, path[i].y].join(','))
    // Merge straight runs before positioning labels; never cover a node or label.
    const simplified = path.filter(
      (p, i) =>
        i === 0 ||
        i === path.length - 1 ||
        !(
          (path[i - 1].x === p.x && p.x === path[i + 1].x) ||
          (path[i - 1].y === p.y && p.y === path[i + 1].y)
        )
    )
    const points = [{ x: a.x + a.width, y: start.y }, ...simplified, { x: b.x, y: end.y }]
    let label: Box | null = null
    if (!edge.lineage) {
      const segments = points
        .slice(1)
        .map((p, i) => ({ a: points[i], b: p }))
        .filter((s) => s.a.y === s.b.y && Math.abs(s.a.x - s.b.x) >= 112)
        .sort((a, b) => Math.abs(b.a.x - b.b.x) - Math.abs(a.a.x - a.b.x))
      for (const segment of segments) {
        const candidate = {
          x: (segment.a.x + segment.b.x) / 2 - 50,
          y: segment.a.y - 11,
          width: 100,
          height: 22
        }
        if (
          ![...obstacleBoxes, ...labels].some((b) => intersects(expanded(candidate, 6), b)) &&
          ![...routed.values()].some((route) =>
            route.points.slice(1).some((p, i) => segmentHits(route.points[i], p, expanded(candidate, 3)))
          )
        ) {
          label = candidate
          labels.push(candidate)
          break
        }
      }
    }
    routed.set(edge.id, { points, label })
  })
  const points = [
    ...nodeBoxes.flatMap((b) => [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y + b.height }
    ]),
    ...[...routed.values()].flatMap((e) => e.points)
  ]
  const minX = Math.min(0, ...points.map((p) => p.x)) - 28,
    minY = Math.min(0, ...points.map((p) => p.y)) - 28
  return {
    positions,
    edges: routed,
    bounds: {
      x: minX,
      y: minY,
      width: Math.max(560, ...points.map((p) => p.x)) - minX + 28,
      height: Math.max(280, ...points.map((p) => p.y)) - minY + 28
    }
  }
}
