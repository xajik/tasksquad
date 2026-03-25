import { useState, useEffect, useCallback } from 'react'
import { api, type Skill } from '../lib/api'
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
import { Loader2, Plus, BookOpen, Trash2, Edit, X, Save, Shield, Zap, RefreshCw } from 'lucide-react'

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function SkillCard({
  skill,
  onClick,
  onDelete,
  onToggleAutoInstall,
}: {
  skill: Skill
  onClick: () => void
  onDelete: () => void
  onToggleAutoInstall: () => void
}) {
  const isDefault = !!skill.is_default
  const autoInstall = !!skill.auto_install

  return (
    <Card
      className="cursor-pointer hover:border-primary/50 transition-all hover:shadow-sm group"
      onClick={onClick}
    >
      <CardHeader className="p-4 pb-2 flex-row items-start justify-between space-y-0">
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <CardTitle className="text-base font-medium line-clamp-1 group-hover:text-primary transition-colors font-mono">
            {skill.name}
          </CardTitle>
          {isDefault && (
            <Badge variant="outline" className="shrink-0 text-xs gap-1">
              <Shield className="h-3 w-3" /> default
            </Badge>
          )}
        </div>
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          onClick={e => e.stopPropagation()}
        >
          {/* Auto-install toggle */}
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${autoInstall ? 'text-primary' : 'text-muted-foreground'} hover:bg-muted`}
            title={autoInstall ? 'Disable auto-install' : 'Enable auto-install'}
            onClick={onToggleAutoInstall}
            disabled={isDefault}
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
          {/* Delete */}
          {!isDefault && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Skill</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete "{skill.name}"? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onDelete}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {skill.description && (
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{skill.description}</p>
        )}
        <div className="flex items-center justify-between gap-2 mt-auto text-xs text-muted-foreground">
          <span>{relativeTime(skill.updated_at)}</span>
          {autoInstall && (
            <span className="flex items-center gap-1 text-primary">
              <Zap className="h-3 w-3" /> auto-install
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

interface SkillDetailProps {
  skill: Skill
  teamId: string
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

function SkillDetail({ skill, teamId, onClose, onSaved, onDeleted }: SkillDetailProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [content, setContent] = useState(skill.content ?? '')
  const [saving, setSaving] = useState(false)
  const [fullSkill, setFullSkill] = useState<Skill | null>(null)

  // Load full content (list view omits content)
  useEffect(() => {
    api.skills.get(teamId, skill.id).then(s => {
      setFullSkill(s)
      setContent(s.content ?? '')
    }).catch(() => {})
  }, [teamId, skill.id])

  const isDefault = !!skill.is_default

  async function handleSave() {
    setSaving(true)
    try {
      await api.skills.update(teamId, skill.id, { name, description, content })
      onSaved()
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-6 pb-4 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="h-5 w-5 text-muted-foreground shrink-0" />
          {editing ? (
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              className="font-mono text-lg font-medium h-8"
            />
          ) : (
            <h2 className="text-lg font-medium font-mono truncate">{skill.name}</h2>
          )}
          {isDefault && (
            <Badge variant="outline" className="shrink-0 text-xs gap-1 ml-1">
              <Shield className="h-3 w-3" /> default
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {!isDefault && !editing && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(true)}>
              <Edit className="h-4 w-4" />
            </Button>
          )}
          {editing && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                <X className="h-4 w-4 mr-1" /> Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                Save
              </Button>
            </>
          )}
          {!isDefault && !editing && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Skill</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete "{skill.name}"? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onDeleted}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-6">
        {editing ? (
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Description</label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this skill do?" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Content (Markdown)</label>
              <Textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                className="font-mono text-sm min-h-[400px]"
              />
            </div>
          </div>
        ) : (
          <>
            {skill.description && (
              <p className="text-sm text-muted-foreground mb-4">{skill.description}</p>
            )}
            {fullSkill === null ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading content…
              </div>
            ) : (
              <pre className="text-sm font-mono whitespace-pre-wrap bg-muted/50 rounded-md p-4 overflow-auto">
                {fullSkill.content ?? '(empty)'}
              </pre>
            )}
            <div className="mt-4 text-xs text-muted-foreground">
              Last updated {relativeTime(skill.updated_at)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function Skills({ teamId }: { teamId: string }) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Skill | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newAutoInstall, setNewAutoInstall] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.skills.list(teamId)
      setSkills(data.skills ?? [])
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => { load() }, [load])

  async function handleDelete(skill: Skill) {
    await api.skills.delete(teamId, skill.id)
    if (selected?.id === skill.id) setSelected(null)
    load()
  }

  async function handleToggleAutoInstall(skill: Skill) {
    await api.skills.update(teamId, skill.id, { auto_install: !skill.auto_install })
    load()
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      await api.skills.create(teamId, { name: newName, description: newDesc, content: newContent, auto_install: newAutoInstall })
      setShowCreate(false)
      setNewName('')
      setNewDesc('')
      setNewContent('')
      setNewAutoInstall(false)
      load()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full">
      {/* List panel */}
      <div className={`flex flex-col ${selected ? 'w-1/2 border-r' : 'w-full'} overflow-hidden`}>
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-4">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Skills</h1>
            {!loading && (
              <span className="text-sm text-muted-foreground ml-1">({skills.length})</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> New Skill
            </Button>
          </div>
        </div>

        {/* Create form */}
        {showCreate && (
          <form onSubmit={handleCreate} className="px-6 pb-4 flex flex-col gap-3 border-b">
            <Input
              placeholder="skill-name (use tsq- prefix for auto-learning)"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="font-mono"
              required
            />
            <Input
              placeholder="Description (optional)"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
            />
            <Textarea
              placeholder="Skill content (Markdown with frontmatter)"
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              className="font-mono text-sm min-h-[120px]"
              required
            />
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setNewAutoInstall(v => !v)}
                className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-md border transition-colors ${
                  newAutoInstall
                    ? 'border-primary/50 bg-primary/5 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <Zap className={`h-3.5 w-3.5 ${newAutoInstall ? 'fill-primary' : ''}`} />
                Auto-install on agents
              </button>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={creating}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Create
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </form>
        )}

        {/* Skills grid */}
        <div className="flex-1 overflow-auto p-6 pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading skills…
            </div>
          ) : skills.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">
              <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No skills yet.</p>
              <p className="text-xs mt-1">Agents automatically create skills as they learn.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {skills.map(skill => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onClick={() => setSelected(skill)}
                  onDelete={() => handleDelete(skill)}
                  onToggleAutoInstall={() => handleToggleAutoInstall(skill)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="flex-1 overflow-hidden">
          <SkillDetail
            key={selected.id}
            skill={selected}
            teamId={teamId}
            onClose={() => setSelected(null)}
            onSaved={load}
            onDeleted={async () => {
              await handleDelete(selected)
            }}
          />
        </div>
      )}
    </div>
  )
}
