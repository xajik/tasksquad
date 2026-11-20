import { useState } from 'react'
import { buildApprovalResponse, validateAnswers, type Answers, type ApprovalRequest } from '@/lib/approval'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'

/** Renders an agent's `needs_input` request (radio, checkbox, text) and sends the answers as a YAML approval_response reply. */
export function ApprovalForm({
  request,
  onSubmit,
  onFreeText
}: {
  request: ApprovalRequest
  onSubmit: (text: string) => Promise<void>
  onFreeText: () => void
}) {
  const [answers, setAnswers] = useState<Answers>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (id: string, value: string | string[]) => setAnswers((a) => ({ ...a, [id]: value }))
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const problem = validateAnswers(request, answers)
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      await onSubmit(buildApprovalResponse(request, answers))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={submit}
      aria-label="Approval request"
      className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-4"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
          Needs your approval
        </p>
        <h3 className="font-semibold text-sm mt-1">{request.title}</h3>
        {request.reason && <p className="text-sm text-muted-foreground mt-1">{request.reason}</p>}
      </div>
      {request.fields.map((f) => (
        <fieldset key={f.id} className="space-y-1.5">
          <legend className="text-sm font-medium">
            {f.label}
            {f.required && <span className="text-destructive"> *</span>}
          </legend>
          {f.type === 'text' && (
            <Textarea
              rows={3}
              maxLength={f.max_length ?? 1000}
              value={(answers[f.id] as string) ?? ''}
              onChange={(e) => set(f.id, e.target.value)}
              className="text-sm"
            />
          )}
          {f.type === 'radio' &&
            f.options?.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={f.id}
                  checked={answers[f.id] === o.id}
                  onChange={() => set(f.id, o.id)}
                />
                {o.label}
              </label>
            ))}
          {f.type === 'checkbox' &&
            f.options?.map((o) => {
              const current = (answers[f.id] as string[] | undefined) ?? []
              return (
                <label key={o.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={current.includes(o.id)}
                    onChange={(e) =>
                      set(f.id, e.target.checked ? [...current, o.id] : current.filter((x) => x !== o.id))
                    }
                  />
                  {o.label}
                </label>
              )
            })}
        </fieldset>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={busy}>
          Send answers
        </Button>
        <button type="button" className="text-xs underline text-muted-foreground" onClick={onFreeText}>
          Reply with text instead
        </button>
      </div>
    </form>
  )
}
