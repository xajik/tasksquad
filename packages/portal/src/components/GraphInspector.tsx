import { goalVerificationLabel } from '@/lib/graphStatus'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type GraphSnapshot,
} from '@/lib/graph'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { isGuidance } from '@/lib/graphLayout'
import { goalProjection } from '@/lib/graphProjection'
import type { GraphAttention } from '@/lib/graphAttention'

import { pretty, stamp } from '@/lib/graphWork'

type Node = GraphSnapshot['nodes'][number]
type Edge = GraphSnapshot['edges'][number]

/** Side panel for the selected node or action: state, evidence, projection, tags and resources. */
export function GraphInspector({
  current,
  node,
  edge,
  nodeAttention,
  projection,
  isMaintainer,
  busy,
  search,
  command,
  onAddResource
}: {
  current: GraphSnapshot
  node: Node | undefined
  edge: Edge | undefined
  nodeAttention: GraphAttention[]
  projection: ReturnType<typeof goalProjection> | null
  isMaintainer: boolean
  busy: boolean
  search: string
  command: (action: string, data?: unknown) => Promise<boolean>
  onAddResource: () => void
}) {
  const nav = useNavigate()
  const [input, setInput] = useState<Record<string, string>>({})
  return (
    <aside className="border-t xl:border-t-0 xl:border-l p-4 space-y-3 text-sm min-w-0">
      <h3 className="font-semibold">{node?.title ?? edge?.title ?? 'Inspector'}</h3>
      {nodeAttention.length > 0 && (
        <section
          aria-label="Inbox attention"
          className="rounded border border-amber-500/30 bg-amber-500/10 p-3 space-y-2"
        >
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {nodeAttention.some((a) => a.kind === 'reply')
              ? 'Waiting for your response'
              : nodeAttention.some((a) => a.kind === 'review')
                ? 'Result awaiting review'
                : 'Recovery in progress'}
          </p>
          {nodeAttention.map((item) => (
            <Button
              key={item.assignmentId}
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() =>
                nav(item.taskId ? `/dashboard/tasks/${item.taskId}` : '/dashboard')
              }
            >
              {item.label}
            </Button>
          ))}
        </section>
      )}
      {node ? (
        <>
          <Badge variant="outline">
            {isGuidance(node) ? `Guidance · ${node.kind}` : `${node.kind} · ${node.state}`}
            {node.reason ? ` / ${node.reason}` : ''}
          </Badge>
          {isGuidance(node) && (
            <p className="text-xs text-muted-foreground">
              Guidance for planning. This item is not an execution state.
            </p>
          )}
          {projection && (
            <section
              aria-label="Projection towards goal"
              className="rounded border border-blue-500/20 bg-blue-500/5 p-3 space-y-2"
            >
              <h4 className="font-medium">Projection towards goal</h4>
              <p>
                {projection.evaluated
                  ? `Goal alignment: ${projection.score === null ? 'Unknown' : projection.score.toFixed(2)}`
                  : 'Not evaluated'}
              </p>
              <p className="text-xs text-muted-foreground">{projection.reason}</p>
              <p className="text-xs">
                Goal verification:{' '}
                {goalVerificationLabel(current.goal_verification)}
              </p>
              {projection.evidenceIds.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs">Projection evidence</summary>
                  <ul className="text-xs break-all mt-2 list-disc pl-4">
                    {projection.evidenceIds.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          <div className="flex flex-wrap gap-1">
            {node.tags?.map((tag) => (
              <Badge variant="secondary" key={tag}>
                {tag}
              </Badge>
            ))}
          </div>
          {(current.evidence ?? [])
            .filter((e) => e.node_id === node.id)
            .map((e) => (
              <p className="text-xs" key={`${e.source_result_id}:${e.predicate}`}>
                {e.predicate}: {e.value} · source {e.resource_id}
              </p>
            ))}
          {isMaintainer && (
            <div className="flex gap-2">
              <Input
                aria-label="New node tag"
                placeholder="Add tag"
                maxLength={99}
                value={input['tag:' + node.id] ?? ''}
                onChange={(e) => setInput({ ...input, ['tag:' + node.id]: e.target.value })}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !input['tag:' + node.id]?.trim()}
                onClick={() =>
                  command('tag', { node_id: node.id, tag: input['tag:' + node.id] })
                }
              >
                Add
              </Button>
            </div>
          )}
          <p>{node.description}</p>
          <p className="whitespace-pre-wrap">{node.body}</p>
          <p className="text-xs text-muted-foreground">
            {isGuidance(node) ? 'Created' : 'Observed'} {stamp(node.created_at)}
          </p>
        </>
      ) : edge ? (
        <>
          <p>Expected quality: {edge.expected_score ?? 'unknown'}</p>
          <p>{edge.description}</p>
          <p className="whitespace-pre-wrap">{edge.body}</p>
          <b className="block">Baseline</b>
          <p>{edge.baseline}</p>
          {(['steps', 'undo_steps', 'predicates', 'resource_versions'] as const).map((key) => (
            <details key={key} open={key === 'undo_steps'}>
              <summary className="cursor-pointer font-medium">
                {
                  {
                    steps: 'Forward plan',
                    undo_steps: 'Undo plan',
                    predicates: 'Restoration predicates',
                    resource_versions: 'Resource versions'
                  }[key]
                }
              </summary>
              <pre className="whitespace-pre-wrap text-xs py-2 break-all">
                {pretty(edge[key])}
              </pre>
            </details>
          ))}
          <p>
            Declared cost {edge.cost} · recovery {edge.recovery_cost}
          </p>
          {current.evaluations
            .filter((v) => v.edge_id === edge.id)
            .slice(-4)
            .map((v) => (
              <p className="text-xs" key={v.id}>
                Local {v.local_score ?? 'unknown'} · goal alignment {v.goal_score ?? 'unknown'}{' '}
                · evidence {v.evidence_id}
              </p>
            ))}
        </>
      ) : (
        <p className="text-muted-foreground">
          Select a node or action to inspect its state, evidence and restoration contract.
        </p>
      )}
      <details open>
        <summary className="cursor-pointer font-medium">Resources</summary>
        {node && isMaintainer && (
          <select
            aria-label="Attach resource to node"
            className="my-2 w-full rounded border bg-background p-2"
            value=""
            onChange={(e) => {
              if (e.target.value)
                void command('link', { node_id: node.id, resource_id: e.target.value })
            }}
          >
            <option value="">Attach resource…</option>
            {current.resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} · v{r.version}
              </option>
            ))}
          </select>
        )}
        {node &&
          (current.resource_links ?? [])
            .filter((l) => l.node_id === node.id)
            .map((l) => (
              <p className="text-xs my-2" key={l.resource_id}>
                Attached: {current.resources.find((r) => r.id === l.resource_id)?.title}
              </p>
            ))}

        <ul className="divide-y">
          {current.resources
            .filter(
              (r) =>
                !search ||
                `${r.title} ${r.description} ${r.body}`
                  .toLowerCase()
                  .includes(search.toLowerCase())
            )
            .map((r) => (
              <li key={r.id} className="py-2">
                <details>
                  <summary className="cursor-pointer">
                    {r.title} · v{r.version}
                  </summary>
                  <p className="text-xs text-muted-foreground">
                    {r.visibility} · {r.id}
                  </p>
                  <p>{r.description}</p>
                  <p className="whitespace-pre-wrap pt-2">{r.body}</p>
                </details>
              </li>
            ))}
        </ul>
        {isMaintainer && (
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={() => onAddResource()}
          >
            Add resource
          </Button>
        )}
      </details>
    </aside>
  )
}
