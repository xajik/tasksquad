import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Note } from '../lib/api'
import { trackEvent } from '../lib/analytics'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Search, FileText, Tag as TagIcon, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

function NoteCard({ note, onClick }: { note: Note; onClick: () => void }) {
  return (
    <Card 
      className="cursor-pointer hover:border-primary/50 transition-all hover:shadow-sm group"
      onClick={onClick}
    >
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base font-medium line-clamp-1 group-hover:text-primary transition-colors">
          {note.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <p className="text-sm text-muted-foreground line-clamp-3 mb-3 font-mono text-xs opacity-80">
          {note.content}
        </p>
        <div className="flex items-center justify-between gap-2 mt-auto">
          <div className="flex flex-wrap gap-1">
            {note.tags && note.tags.slice(0, 3).map(tag => (
              <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-5">
                {tag}
              </Badge>
            ))}
            {note.tags && note.tags.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{note.tags.length - 3}</span>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {new Date(note.updated_at).toLocaleDateString()}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

export function Notes({ teamId }: { teamId: string }) {
  const [notes, setNotes] = useState<Note[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const nav = useNavigate()

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const d = await api.notes.list(teamId)
      setNotes(d.notes ?? [])
    } finally {
      setIsLoading(false)
    }
  }, [teamId])

  useEffect(() => { load() }, [load])

  const allTags = Array.from(new Set(notes.flatMap(n => n.tags || []))).sort()

  const filteredNotes = notes.filter(n => {
    const matchesSearch = n.title.toLowerCase().includes(search.toLowerCase()) || 
                          n.content.toLowerCase().includes(search.toLowerCase())
    const matchesTag = selectedTag ? n.tags?.includes(selectedTag) : true
    return matchesSearch && matchesTag
  })

  async function createNote() {
    setCreating(true)
    try {
      const note = await api.notes.create(teamId, {
        title: 'Untitled Note',
        content: '',
        tags: []
      })
      trackEvent('note_created', { team_id: teamId })
      nav(`/dashboard/notes/${note.id}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="animate-fade-in h-full flex flex-col">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold">Notes</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={load} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button onClick={createNote} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
          New Note
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-6 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search notes..."
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {allTags.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0 no-scrollbar max-w-full sm:max-w-md">
            <Button
              variant={selectedTag === null ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSelectedTag(null)}
              className="text-xs h-8"
            >
              All
            </Button>
            {allTags.map(tag => (
              <Button
                key={tag}
                variant={selectedTag === tag ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                className={cn("text-xs h-8 whitespace-nowrap", selectedTag === tag && "bg-primary/10 text-primary hover:bg-primary/20")}
              >
                <TagIcon className="h-3 w-3 mr-1.5 opacity-70" />
                {tag}
              </Button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Card key={i} className="h-32 animate-pulse bg-muted/20 border-border/50" />
          ))}
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground border-2 border-dashed rounded-xl bg-muted/10">
          <FileText className="h-12 w-12 mb-4 opacity-20" />
          <p>No notes found.</p>
          {(search || selectedTag) && (
            <Button variant="link" onClick={() => { setSearch(''); setSelectedTag(null) }}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-8">
          {filteredNotes.map(note => (
            <NoteCard 
              key={note.id} 
              note={note} 
              onClick={() => nav(`/dashboard/notes/${note.id}`)} 
            />
          ))}
        </div>
      )}
    </div>
  )
}
