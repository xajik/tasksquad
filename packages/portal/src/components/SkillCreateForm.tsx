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

export function SkillCreateForm({ onSubmit, onCancel, error }: Props) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [content, setContent] = useState('---\nname: \ndescription:\n---\n# ')
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
      <Input placeholder="skill-name" value={name} onChange={e => setName(e.target.value)} className="font-mono" required />
      <Input placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} />
      <Textarea
        placeholder="---&#10;name: my-skill&#10;description: What this skill does&#10;---&#10;# Instructions"
        value={content} onChange={e => setContent(e.target.value)}
        className="font-mono text-sm min-h-[120px]" required
      />
      <div className="text-[10px] text-muted-foreground bg-muted/30 p-2.5 rounded border border-dashed font-mono">
        <button type="button" onClick={() => setShowExample(v => !v)}
          className="flex items-center gap-1.5 text-[11px] font-bold text-foreground opacity-60 uppercase tracking-tight hover:opacity-100 transition-opacity w-full">
          <span className={`transition-transform ${showExample ? 'rotate-90' : ''}`}>{'>'}</span> Example
        </button>
        {showExample && (
          <div className="space-y-0.5 opacity-80 mt-1.5">
            ---<br />name: my-skill<br />description: brief summary<br />---<br /><br /># Instructions<br />1. First do X<br />2. Then do Y
          </div>
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
