import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Zap } from 'lucide-react'

interface Props {
  onSubmit: (fields: { name: string; desc: string; content: string; autoInstall: boolean }) => Promise<void>
  onCancel: () => void
  error: string | null
}

const EXAMPLE_CONTENT = `---
description: Run tests with coverage
agent: build
model: anthropic/claude-3-5-sonnet-20241022
---

Run the full test suite with coverage report and show any failures.

Focus on the failing tests and suggest fixes.`

export function CommandCreateForm({ onSubmit, onCancel, error }: Props) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [content, setContent] = useState('---\ndescription: \nagent: \nmodel: \n---\n\n')
  const [autoInstall, setAutoInstall] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [showExample, setShowExample] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try { await onSubmit({ name, desc, content, autoInstall }) } finally { setSubmitting(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="px-6 pb-4 flex flex-col gap-3 border-b">
      {error && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-md">{error}</div>}
      <Input placeholder="command-name" value={name} onChange={e => setName(e.target.value)} className="font-mono" required />
      <Input placeholder="Description — what this command does" value={desc} onChange={e => setDesc(e.target.value)} />
      <Textarea
        placeholder={EXAMPLE_CONTENT}
        value={content} onChange={e => setContent(e.target.value)}
        className="font-mono text-sm min-h-[180px]" required
      />
      <div className="text-[10px] text-muted-foreground bg-muted/30 p-2.5 rounded border border-dashed font-mono">
        <button type="button" onClick={() => setShowExample(v => !v)}
          className="flex items-center gap-1.5 text-[11px] font-bold text-foreground opacity-60 uppercase tracking-tight hover:opacity-100 transition-opacity w-full">
          <span className={`transition-transform ${showExample ? 'rotate-90' : ''}`}>{'>'}</span> Example
        </button>
        {showExample && (
          <div className="space-y-0.5 opacity-80 mt-1.5 whitespace-pre-wrap">{EXAMPLE_CONTENT}</div>
        )}
        {!showExample && (
          <p className="opacity-60 mt-1 text-[10px]">
            Frontmatter fields: <code>description</code> (required), <code>agent</code> (optional), <code>model</code> (optional).
            Saved to <code>.opencode/commands/[name].md</code> on each machine.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setAutoInstall(v => !v)}
          className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-md border transition-colors ${autoInstall ? 'border-primary/50 bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
          <Zap className={`h-3.5 w-3.5 ${autoInstall ? 'fill-primary' : ''}`} /> Auto-install on agents
        </button>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={submitting}>{submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Create</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </form>
  )
}
