import { describe, it, expect } from 'vitest'
import { layoutGraph, intersects, segmentHits, type LayoutNode, type LayoutEdge } from './graphLayout'
const node = (id: string, kind = 'observed', created_at = 0): LayoutNode => ({ id, kind, created_at })
const edge = (id: string, from_id: string, to_id: string): LayoutEdge => ({ id, from_id, to_id })
function assertClear(layout: ReturnType<typeof layoutGraph>, edges: LayoutEdge[]) {
  const boxes = [...layout.positions.values()]
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) expect(intersects(boxes[i], boxes[j])).toBe(false)
  for (const e of edges) {
    const route = layout.edges.get(e.id)!
    expect(route).toBeDefined()
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i]
      expect(a.x === b.x || a.y === b.y).toBe(true)
      for (const box of boxes) expect(segmentHits(a, b, box), `${e.id} crosses node`).toBe(false)
      for (const [id, other] of layout.edges)
        if (id !== e.id && other.label)
          expect(segmentHits(a, b, other.label), `${e.id} crosses label ${id}`).toBe(false)
    }
    if (route.label) for (const box of boxes) expect(intersects(route.label, box)).toBe(false)
  }
  const labels = [...layout.edges.values()].flatMap((e) => (e.label ? [e.label] : []))
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) expect(intersects(labels[i], labels[j])).toBe(false)
}
describe('execution graph layout', () => {
  it('keeps guidance out of execution geometry and ignores edges to guidance', () => {
    const layout = layoutGraph(
      [node('goal', 'goal'), node('m', 'milestone'), node('a')],
      [edge('bad', 'a', 'm')]
    )
    expect([...layout.positions.keys()]).toEqual(['a'])
    expect(layout.edges.size).toBe(0)
  })
  it('packs guidance and execution together without collisions when shown on one canvas', () => {
    const nodes = [
      node('goal', 'goal'),
      node('m1', 'milestone', 1),
      node('m2', 'milestone', 2),
      node('start', 'observed', 3),
      node('result', 'outcome', 4)
    ]
    const edges = [
      { ...edge('hierarchy-1', 'goal', 'm1'), lineage: true },
      { ...edge('hierarchy-2', 'goal', 'm2'), lineage: true },
      edge('action', 'start', 'result')
    ]
    const layout = layoutGraph(nodes, edges, true)
    expect(layout.positions.size).toBe(5)
    assertClear(layout, edges)
  })
  it('routes branches, long edges, cycles, parallel edges and self loops around cards and labels', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(String(i), 'outcome', i))
    const edges = [
      ...Array.from({ length: 8 }, (_, i) => edge(`branch-${i}`, '0', String(i + 1))),
      edge('join-a', '2', '9'),
      edge('join-b', '7', '9'),
      edge('long', '0', '9'),
      edge('cycle', '9', '0'),
      edge('parallel', '0', '1'),
      edge('self', '4', '4'),
      edge('separate', '10', '11')
    ]
    const layout = layoutGraph(nodes, edges)
    assertClear(layout, edges)
    expect(layout.edges.get('parallel')?.points).not.toEqual(layout.edges.get('branch-0')?.points)
    expect([...layout.edges.values()].some((e) => e.label !== null)).toBe(true)
    expect(layoutGraph([...nodes].reverse(), [...edges].reverse())).toEqual(layout)
  })
  it('repacks when a new connected state arrives without introducing collisions', () => {
    const nodes = [node('a'), node('b', 'outcome', 1)],
      edges = [edge('ab', 'a', 'b')]
    const before = layoutGraph(nodes, edges)
    const nextEdges = [...edges, edge('ac', 'a', 'c'), edge('cd', 'c', 'd')]
    const after = layoutGraph([...nodes, node('c', 'outcome', 2), node('d', 'outcome', 3)], nextEdges)
    expect(after.positions.size).toBe(4)
    expect(after.positions.get('a')).not.toEqual(before.positions.get('a'))
    assertClear(after, nextEdges)
  })
})
