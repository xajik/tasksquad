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

/** Condense cycles before ranking so every inter-component execution edge flows LTR. */
function flowRanks(ids: string[], outgoing: Map<string, string[]>) {
  let clock = 0
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    active = new Set<string>(),
    components: string[][] = []
  function visit(id: string) {
    index.set(id, clock)
    low.set(id, clock++)
    stack.push(id)
    active.add(id)
    for (const next of outgoing.get(id) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(id, Math.min(low.get(id)!, low.get(next)!))
      } else if (active.has(next)) low.set(id, Math.min(low.get(id)!, index.get(next)!))
    }
    if (low.get(id) === index.get(id)) {
      const members: string[] = []
      let member: string
      do {
        member = stack.pop()!
        active.delete(member)
        members.push(member)
      } while (member !== id)
      components.push(members)
    }
  }
  ids.forEach((id) => {
    if (!index.has(id)) visit(id)
  })
  const owner = new Map<string, number>()
  components.forEach((members, i) => members.forEach((id) => owner.set(id, i)))
  const targets = components.map(() => new Set<number>()),
    incoming = components.map(() => 0),
    ranks = components.map(() => 0)
  for (const id of ids)
    for (const next of outgoing.get(id) ?? []) {
      const a = owner.get(id)!,
        b = owner.get(next)!
      if (a !== b && !targets[a].has(b)) {
        targets[a].add(b)
        incoming[b]++
      }
    }
  const queue = components.map((_, i) => i).filter((i) => incoming[i] === 0)
  while (queue.length) {
    const a = queue.shift()!
    for (const b of targets[a]) {
      ranks[b] = Math.max(ranks[b], ranks[a] + 1)
      if (--incoming[b] === 0) queue.push(b)
    }
  }
  return new Map(ids.map((id) => [id, ranks[owner.get(id)!]]))
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
  for (const e of edges) {
    neighbors.get(e.from_id)!.add(e.to_id)
    neighbors.get(e.to_id)!.add(e.from_id)
    outgoing.get(e.from_id)!.push(e.to_id)
  }
  const positions = new Map<string, Box>(),
    visited = new Set<string>()
  const tops = { execution: 48, guidance: 48 }
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
    const side = component.every((id) => isGuidance(nodes.find((n) => n.id === id)!))
      ? 'guidance'
      : 'execution'
    const top = tops[side]
    const ranks = flowRanks(component, outgoing)
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
    tops[side] += rows * 140 + 64
  }
  // Strict spatial partition: all guidance sits beyond every execution card.
  const executionNodes = nodes.filter((n) => !isGuidance(n))
  const guidanceNodes = nodes.filter(isGuidance)
  const executionRight = Math.max(
    48,
    ...executionNodes.map((n) => {
      const box = positions.get(n.id)!
      return box.x + box.width
    })
  )
  const guidanceRight = Math.max(
    48 + NODE_WIDTH,
    ...guidanceNodes.map((n) => {
      const box = positions.get(n.id)!
      return box.x + box.width
    })
  )
  const guidanceLeft = executionNodes.length ? executionRight + 180 : 48
  for (const node of guidanceNodes) {
    const box = positions.get(node.id)!
    box.x = guidanceLeft + guidanceRight - box.x - box.width
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
    const rtl =
      isGuidance(nodes.find((n) => n.id === edge.from_id)!) &&
      isGuidance(nodes.find((n) => n.id === edge.to_id)!)
    const sourceX = rtl ? a.x : a.x + a.width,
      targetX = rtl ? b.x + b.width : b.x
    const start = { x: sourceX + (rtl ? -PAD : PAD), y: portY(a, sourceGroups.get(edge.from_id)!, edge) }
    const end = { x: targetX + (rtl ? PAD : -PAD), y: portY(b, targetGroups.get(edge.to_id)!, edge) }
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
    const points = [{ x: sourceX, y: start.y }, ...simplified, { x: targetX, y: end.y }]
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

/** Selection-only overlay: route without repacking the canvas or moving its viewport. */
export function projectionRoute(layout: ReturnType<typeof layoutGraph>, fromId: string, goalId: string) {
  const a = layout.positions.get(fromId),
    b = layout.positions.get(goalId)
  if (!a || !b || fromId === goalId) return []
  const below = b.y >= a.y + a.height,
    above = b.y + b.height <= a.y
  let source: Point, target: Point, start: Point, end: Point
  if (below || above) {
    const direction = below ? 1 : -1
    source = { x: a.x + a.width / 2, y: below ? a.y + a.height : a.y }
    target = { x: b.x + b.width / 2, y: below ? b.y : b.y + b.height }
    start = { x: source.x, y: source.y + direction * PAD }
    end = { x: target.x, y: target.y - direction * PAD }
  } else {
    const direction = b.x > a.x ? 1 : -1
    source = { x: direction > 0 ? a.x + a.width : a.x, y: a.y + a.height / 2 }
    target = { x: direction > 0 ? b.x : b.x + b.width, y: b.y + b.height / 2 }
    start = { x: source.x + direction * PAD, y: source.y }
    end = { x: target.x - direction * PAD, y: target.y }
  }
  const obstacles = [
    ...[...layout.positions.values()].map((box) => expanded(box)),
    ...[...layout.edges.values()].flatMap((e) => (e.label ? [expanded(e.label, 6)] : []))
  ]
  const bounds = {
    x: layout.bounds.x + 8,
    y: layout.bounds.y + 8,
    width: layout.bounds.width - 16,
    height: layout.bounds.height - 16
  }
  return [source, ...route(start, end, obstacles, bounds, new Set()), target]
}
