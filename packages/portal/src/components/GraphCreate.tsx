import { useState, type FormEvent } from 'react'
import { type Agent } from '@/lib/api'
import {
  defaultGraphPolicy,
  graphApi,
  type GraphSummary,
  type NewGraph,
  type GraphPolicy,
} from '@/lib/graph'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { FieldHelp, LabelText } from '@/components/FieldHelp'
import type { GraphHelpKey } from '@/lib/graphHelp'
import { errorText } from '@/lib/graphError'



export function PolicyFields({
  value,
  onChange,
  agents
}: {
  value: GraphPolicy
  onChange: (p: GraphPolicy) => void
  agents: Agent[]
}) {
  const field = (key: keyof GraphPolicy, next: unknown) => onChange({ ...value, [key]: next })
  const agentSelect = (key: 'grader' | 'decomposer' | 'fallback', label: string) => (
    <Label className="grid min-w-0 gap-2">
      <LabelText field={key}>{label}</LabelText>
      <select
        className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
        value={value[key] ?? ''}
        onChange={(e) => field(key, e.target.value || null)}
        required={key !== 'fallback'}
      >
        <option value="">{key === 'fallback' ? 'None' : 'Select agent'}</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </Label>
  )
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="inline-flex items-center text-sm font-medium">
          Execution agents
          <FieldHelp field="agents" />
        </legend>
        {agents.map((a) => (
          <Label key={a.id} className="inline-flex items-center gap-2 mr-4">
            <input
              type="checkbox"
              checked={value.agents.includes(a.id)}
              onChange={(e) =>
                field(
                  'agents',
                  e.target.checked ? [...value.agents, a.id] : value.agents.filter((id) => id !== a.id)
                )
              }
            />
            {a.name}
          </Label>
        ))}
      </fieldset>
      <div className="grid sm:grid-cols-3 gap-4">
        {agentSelect('decomposer', 'Decomposition agent')}
        {agentSelect('grader', 'Grading agent')}
        {agentSelect('fallback', 'Fallback agent')}
      </div>
      <p className="text-xs text-muted-foreground">
        Execution needs an agent separate from the grader. Existing local agents remain trusted with machine
        access.
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        <Label className="grid min-w-0 gap-2">
          <LabelText field="capacity">Execution slots</LabelText>
          <Input
            type="number"
            min={1}
            max={32}
            value={value.capacity}
            onChange={(e) => field('capacity', Number(e.target.value))}
          />
        </Label>
        <Label className="grid min-w-0 gap-2">
          <LabelText field="threshold">Necessity threshold</LabelText>
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={value.threshold}
            onChange={(e) => field('threshold', Number(e.target.value))}
          />
        </Label>
        <Label className="grid min-w-0 gap-2 sm:col-span-2">
          <LabelText field="review">Result acceptance</LabelText>
          <select
            className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
            value={value.review ? 'review' : 'auto'}
            onChange={(e) => field('review', e.target.value === 'review')}
          >
            <option value="review">Require review for every role</option>
            <option value="auto">Accept valid results automatically</option>
          </select>
        </Label>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">Budgets, retries and maintenance</summary>
        <div className="grid sm:grid-cols-3 gap-4 pt-4">
          {(
            [
              ['max_attempts', 'Attempts per assignment', 1, 1],
              ['attempt_budget', 'Total attempt budget', 1, 1],
              ['planning_budget', 'Planning attempt budget', 1, 1],
              ['cost_budget', 'Declared execution cost limit', 0, 0.1],
              ['recovery_budget', 'Reserved recovery cost limit', 0, 0.1],
              ['deadline_ms', 'Job deadline (minutes)', 1, 1, 60_000],
              ['ttl_ms', 'Candidate TTL (hours)', 1, 1, 3600_000],
              ['maintenance_ms', 'Maintenance interval (minutes)', 1, 1, 60_000],
              ['freshness_ms', 'Evidence freshness (hours)', 1, 1, 3600_000]
            ] as const
          ).map(([key, label, min, step, unit = 1]) => (
            <Label key={key} className="grid min-w-0 gap-2">
              <LabelText field={key as GraphHelpKey}>{label}</LabelText>
              <Input
                type="number"
                min={min}
                step={step}
                value={value[key] / unit}
                onChange={(e) => field(key, Number(e.target.value) * unit)}
              />
            </Label>
          ))}
        </div>
      </details>
    </>
  )
}

export function CreateGraph({
  teamId,
  agents,
  onCreated
}: {
  teamId: string
  agents: Agent[]
  onCreated: (g: GraphSummary) => void
}) {
  const [form, setForm] = useState<NewGraph>({
    title: '',
    description: '',
    body: '',
    start_state: '',
    policy: { ...defaultGraphPolicy },
    rule: { op: 'AND', predicates: [], scope: '' }
  })
  const [predicates, setPredicates] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onCreated(
        await graphApi.create(teamId, {
          ...form,
          rule: {
            ...form.rule,
            predicates: predicates
              .split('\n')
              .map((p) => p.trim())
              .filter(Boolean)
          }
        })
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      {(['title', 'description', 'body', 'start_state'] as const).map((key) => (
        <Label className="grid gap-2" key={key}>
          <LabelText field={key}>
            {
              {
                title: 'Graph name',
                description: 'Short description',
                body: 'Goal and success definition',
                start_state: 'Observed start state'
              }[key]
            }
          </LabelText>
          {key === 'title' || key === 'description' ? (
            <Input
              required={key === 'title'}
              maxLength={key === 'title' ? 299 : 299}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          ) : (
            <Textarea
              required
              maxLength={3999}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          )}
        </Label>
      ))}
      <Label className="grid gap-2">
        <LabelText field="predicates">Success predicates (one per line)</LabelText>
        <Textarea
          required
          value={predicates}
          onChange={(e) => setPredicates(e.target.value)}
          placeholder="Measured result meets the target over the declared window"
        />
      </Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Label className="grid min-w-0 gap-2">
          <LabelText field="rule">Sufficient rule</LabelText>
          <select
            className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
            value={form.rule.op}
            onChange={(e) => setForm({ ...form, rule: { ...form.rule, op: e.target.value as 'AND' | 'OR' } })}
          >
            <option>AND</option>
            <option>OR</option>
          </select>
        </Label>
        <Label className="grid min-w-0 gap-2">
          <LabelText field="scope">Evidence scope</LabelText>
          <Input
            required
            maxLength={299}
            value={form.rule.scope}
            onChange={(e) => setForm({ ...form, rule: { ...form.rule, scope: e.target.value } })}
            placeholder="Production · declared cohort/window"
          />
        </Label>
      </div>
      <PolicyFields value={form.policy} onChange={(policy) => setForm({ ...form, policy })} agents={agents} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy || !agents.length}>{busy ? 'Creating…' : 'Create draft graph'}</Button>
    </form>
  )
}
