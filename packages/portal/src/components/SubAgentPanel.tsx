import { useState, useEffect } from 'react'
import { api, type SubAgent } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Loader2, Bot, Trash2, Edit, X, Save, Shield, Zap, User } from 'lucide-react'
import { relativeTime } from '../lib/utils'

export function SubAgentCard({
  agent,
  members,
  onClick,
  onDelete,
  onToggleAutoInstall,
}: {
  agent: SubAgent
  members: Map<string, string>
  onClick: () => void
  onDelete: () => void
  onToggleAutoInstall: () => void
}) {
  const isProtected = !!agent.is_default
  const autoInstall = !!agent.auto_install
  const authorLabel = agent.author_id !== null
    ? (members.get(agent.author_id) ?? agent.author_id.slice(0, 8))
    : null

  return (
    <Card className="cursor-pointer hover:border-primary/50 transition-all hover:shadow-sm group" onClick={onClick}>
      <CardHeader className="p-4 pb-2 flex-row items-start justify-between space-y-0">
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <CardTitle className="text-base font-medium line-clamp-1 group-hover:text-primary transition-colors font-mono">
            {agent.name}
          </CardTitle>
          {isProtected && (
            <Badge variant="outline" className="shrink-0 text-xs gap-1">
              <Shield className="h-3 w-3" /> default
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost" size="icon"
            className={`h-7 w-7 ${autoInstall ? 'text-primary' : 'text-muted-foreground'} hover:bg-muted`}
            title={autoInstall ? 'Disable auto-install' : 'Enable auto-install'}
            onClick={onToggleAutoInstall}
            disabled={isProtected}
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
          {!isProtected && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Sub-agent</AlertDialogTitle>
                  <AlertDialogDescription>Are you sure you want to delete "{agent.name}"? This action cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {agent.description && <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{agent.description}</p>}
        <div className="flex items-center justify-between gap-2 mt-auto text-xs text-muted-foreground">
          <span>{relativeTime(agent.updated_at)}</span>
          <div className="flex items-center gap-2">
            {authorLabel && <span className="flex items-center gap-1"><User className="h-3 w-3" /> {authorLabel}</span>}
            {autoInstall && <span className="flex items-center gap-1 text-primary"><Zap className="h-3 w-3" /> auto-install</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function SubAgentDetail({
  agent,
  teamId,
  members,
  onClose,
  onSaved,
  onDeleted,
}: {
  agent: SubAgent
  teamId: string
  members: Map<string, string>
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description)
  const [content, setContent] = useState(agent.content ?? '')
  const [saving, setSaving] = useState(false)
  const [fullAgent, setFullAgent] = useState<SubAgent | null>(null)

  const isProtected = !!agent.is_default
  const authorLabel = agent.author_id !== null
    ? (members.get(agent.author_id) ?? agent.author_id.slice(0, 8))
    : null

  useEffect(() => {
    api.subAgents.get(teamId, agent.id).then(a => { setFullAgent(a); setContent(a.content ?? '') }).catch(() => {})
  }, [teamId, agent.id])

  async function handleSave() {
    setSaving(true)
    try {
      await api.subAgents.update(teamId, agent.id, { name, description, content })
      onSaved()
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-6 pb-4 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-5 w-5 text-muted-foreground shrink-0" />
          {editing
            ? <Input value={name} onChange={e => setName(e.target.value)} className="font-mono text-lg font-medium h-8" />
            : <h2 className="text-lg font-medium font-mono truncate">{agent.name}</h2>
          }
          {isProtected && <Badge variant="outline" className="shrink-0 text-xs gap-1 ml-1"><Shield className="h-3 w-3" /> default</Badge>}
          {authorLabel && <Badge variant="secondary" className="shrink-0 text-xs gap-1 ml-1"><User className="h-3 w-3" /> {authorLabel}</Badge>}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {!isProtected && !editing && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(true)}><Edit className="h-4 w-4" /></Button>}
          {editing && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}><X className="h-4 w-4 mr-1" /> Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Save
              </Button>
            </>
          )}
          {!isProtected && !editing && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Sub-agent</AlertDialogTitle>
                  <AlertDialogDescription>Are you sure you want to delete "{agent.name}"? This action cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onDeleted} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {editing ? (
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Description</label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="When to invoke this sub-agent" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Content (Markdown with YAML frontmatter)</label>
              <Textarea value={content} onChange={e => setContent(e.target.value)} className="font-mono text-sm min-h-[400px]" />
            </div>
          </div>
        ) : (
          <>
            {agent.description && <p className="text-sm text-muted-foreground mb-4">{agent.description}</p>}
            {fullAgent === null
              ? <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading content…</div>
              : <pre className="text-sm font-mono whitespace-pre-wrap bg-muted/50 rounded-md p-4 overflow-auto">{fullAgent.content ?? '(empty)'}</pre>
            }
            <div className="mt-4 text-xs text-muted-foreground">Last updated {relativeTime(agent.updated_at)}</div>
          </>
        )}
      </div>
    </div>
  )
}
