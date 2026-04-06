import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
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
import { Loader2, Plus, BookOpen, Trash2, Edit, X, Save, Shield, Zap, RefreshCw, HelpCircle, ChevronUp, ChevronDown, ExternalLink } from 'lucide-react'
import { SkillWorkflow } from '../components/SkillWorkflow'

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
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [showExample, setShowExample] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newAutoInstall, setNewAutoInstall] = useState(false)
  const [creating, setCreating] = useState(false)
  const [autoInstallFilter, setAutoInstallFilter] = useState<boolean | null>(null)

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

  const filteredSkills = useMemo(() => {
    if (autoInstallFilter === null) return skills
    return skills.filter(s => !!s.auto_install === autoInstallFilter)
  }, [skills, autoInstallFilter])

  async function handleDelete(skill: Skill) {
    await api.skills.delete(teamId, skill.id)
    if (selected?.id === skill.id) setSelected(null)
    load()
  }

  async function handleToggleAutoInstall(skill: Skill) {
    await api.skills.update(teamId, skill.id, { auto_install: !skill.auto_install })
    load()
  }

  const [createError, setCreateError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      await api.skills.create(teamId, { name: newName, description: newDesc, content: newContent, auto_install: newAutoInstall })
      setShowCreate(false)
      setNewName('')
      setNewDesc('')
      setNewContent('')
      setNewAutoInstall(false)
      load()
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'error' in err ? String((err as { error: unknown }).error) : 'Failed to create skill'
      setCreateError(msg)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full">
      {/* List panel */}
      <div className={`flex flex-col ${selected ? 'w-1/2 border-r' : 'w-full'} overflow-hidden`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-1.5">
            <h2 className="text-2xl font-semibold">Skills</h2>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={load} disabled={loading} title="Refresh">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button 
              variant="ghost" 
              size="sm" 
              className={`h-7 px-2 text-xs gap-1.5 ${showHowItWorks ? 'bg-primary/5 text-primary' : 'text-muted-foreground'}`}
              onClick={() => setShowHowItWorks(!showHowItWorks)}
            >
              <HelpCircle className="h-3.5 w-3.5" />
              How it works
              {showHowItWorks ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>
          <Button size="sm" onClick={() => { setShowCreate(true); setNewContent('---\nname: \ndescription:\n---\n# ') }}>
            <Plus className="h-4 w-4 mr-1" /> New Skill
          </Button>
        </div>

        {/* How it works section */}
        {showHowItWorks && (
          <div className="mx-6 mb-6 p-4 rounded-xl border bg-muted/30 relative group overflow-hidden">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                <Zap className="h-4 w-4 text-primary" />
                Autonomous Learning Loop
              </h3>
              <Link 
                to="/docs/concepts/skills" 
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                Full Documentation <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
            <SkillWorkflow />
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              TaskSquad agents automatically learn new skills by analyzing completed tasks. 
              Skills prefixed with <code className="text-primary font-mono font-bold px-1 py-0.5 bg-primary/5 rounded">tsq-</code> are 
              extracted and shared back to your team, where you can enable auto-install for all agents.
            </p>
          </div>
        )}

        {/* Filters row */}
        <div className="flex items-center gap-1.5 mb-4 shrink-0">
          <Button
            variant={autoInstallFilter === null ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoInstallFilter(null)}
            className="h-7 rounded-full px-3 text-xs"
          >
            All
          </Button>
          <Button
            variant={autoInstallFilter === true ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoInstallFilter(autoInstallFilter === true ? null : true)}
            className="h-7 rounded-full px-3 text-xs"
          >
            <Zap className="h-3 w-3 mr-1" />
            Auto-install
          </Button>
        </div>

        {/* Create form */}
        {showCreate && (
          <form onSubmit={handleCreate} className="px-6 pb-4 flex flex-col gap-3 border-b">
            {createError && (
              <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-md">
                {createError}
              </div>
            )}
            <Input
              placeholder="skill-name"
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
              placeholder="---
name: my-skill
description: What this skill does
---
# Instructions
Your skill content here..."
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              className="font-mono text-sm min-h-[120px]"
              required
            />
            <div className="text-[10px] text-muted-foreground bg-muted/30 p-2.5 rounded border border-dashed font-mono">
              <button
                type="button"
                onClick={() => setShowExample(v => !v)}
                className="flex items-center gap-1.5 text-[11px] font-bold text-foreground opacity-60 uppercase tracking-tight hover:opacity-100 transition-opacity w-full"
              >
                <span className={`transition-transform ${showExample ? 'rotate-90' : ''}`}>{'>'}</span>
                Example
              </button>
              {showExample && (
                <div className="space-y-0.5 opacity-80 mt-1.5">
                  ---<br />
                  name: my-skill<br />
                  description: brief summary of the skill<br />
                  ---<br />
                  <br />
                  # Instructions<br />
                  Step-by-step guidance for the agent.<br />
                  1. First do X<br />
                  2. Then do Y
                </div>
              )}
            </div>
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
          ) : filteredSkills.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">
              <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{autoInstallFilter ? 'No auto-install skills.' : 'No skills yet.'}</p>
              <p className="text-xs mt-1">Agents automatically create skills as they learn.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filteredSkills.map(skill => (
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
