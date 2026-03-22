import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Note } from '../lib/api'
import { trackEvent } from '../lib/analytics'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { Loader2, Plus, Search, FileText, Tag as TagIcon, RefreshCw, Trash2, Archive, ArchiveRestore } from 'lucide-react'
import { cn } from '@/lib/utils'

const LIMIT = 20

function NoteCard({
  note,
  onClick,
  onDelete,
  onArchive,
  onUnarchive,
}: {
  note: Note
  onClick: () => void
  onDelete: () => void
  onArchive?: () => void
  onUnarchive?: () => void
}) {
  return (
    <Card
      className="cursor-pointer hover:border-primary/50 transition-all hover:shadow-sm group"
      onClick={onClick}
    >
      <CardHeader className="p-4 pb-2 flex-row items-start justify-between space-y-0">
        <CardTitle className="text-base font-medium line-clamp-1 group-hover:text-primary transition-colors pr-2">
          {note.title}
        </CardTitle>
        <div
          className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          onClick={e => e.stopPropagation()}
        >
          {/* Archive / Unarchive */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
            title={note.archived_at ? 'Unarchive' : 'Archive'}
            onClick={() => note.archived_at ? onUnarchive?.() : onArchive?.()}
          >
            {note.archived_at
              ? <ArchiveRestore className="h-3.5 w-3.5" />
              : <Archive className="h-3.5 w-3.5" />}
          </Button>
          {/* Delete */}
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
                <AlertDialogTitle>Delete Note</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete "{note.title}"? This action cannot be undone.
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
        </div>
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
  const [liveNotes, setLiveNotes] = useState<Note[]>([])
  const [liveHasMore, setLiveHasMore] = useState(false)

  const [archivedNotes, setArchivedNotes] = useState<Note[]>([])
  const [archivedHasMore, setArchivedHasMore] = useState(false)
  const [archivedLoaded, setArchivedLoaded] = useState(false)

  const [showArchived, setShowArchived] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const nav = useNavigate()

  async function fetchNotes(archived: boolean, offset: number, append: boolean) {
    if (offset === 0) setIsLoading(true)
    else setIsLoadingMore(true)
    try {
      const d = await api.notes.list(teamId, { archived, limit: LIMIT, offset })
      const fetched = d.notes ?? []
      if (archived) {
        setArchivedNotes(append ? prev => [...prev, ...fetched] : fetched)
        setArchivedHasMore(d.has_more)
        setArchivedLoaded(true)
      } else {
        setLiveNotes(append ? prev => [...prev, ...fetched] : fetched)
        setLiveHasMore(d.has_more)
      }
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchNotes(false, 0, false) }, [teamId])

  function handleShowArchived(val: boolean) {
    setShowArchived(val)
    setSearch('')
    setSelectedTag(null)
    if (val && !archivedLoaded) fetchNotes(true, 0, false)
  }

  async function refresh() {
    setArchivedNotes([])
    setArchivedLoaded(false)
    await fetchNotes(showArchived, 0, false)
  }

  function loadMore() {
    const current = showArchived ? archivedNotes : liveNotes
    fetchNotes(showArchived, current.length, true)
  }

  async function handleDelete(noteId: string) {
    try {
      await api.notes.delete(teamId, noteId)
      setLiveNotes(prev => prev.filter(n => n.id !== noteId))
      setArchivedNotes(prev => prev.filter(n => n.id !== noteId))
      trackEvent('note_deleted', { note_id: noteId, team_id: teamId })
    } catch (e) {
      console.error('Failed to delete note:', e)
    }
  }

  async function handleArchive(note: Note) {
    await api.notes.archive(teamId, note.id)
    trackEvent('note_archived', { team_id: teamId })
    setLiveNotes(prev => prev.filter(n => n.id !== note.id))
    // Invalidate archived cache so it reflects the new entry on next load
    setArchivedNotes([])
    setArchivedLoaded(false)
  }

  async function handleUnarchive(note: Note) {
    await api.notes.unarchive(teamId, note.id)
    trackEvent('note_unarchived', { team_id: teamId })
    setArchivedNotes(prev => prev.filter(n => n.id !== note.id))
    // Refresh live notes to include the restored note
    setLiveNotes([])
    fetchNotes(false, 0, false)
  }

  async function createNote() {
    setCreating(true)
    try {
      const note = await api.notes.create(teamId, { title: 'Untitled Note', content: '', tags: [] })
      trackEvent('note_created', { team_id: teamId })
      nav(`/dashboard/notes/${note.id}`)
    } finally {
      setCreating(false)
    }
  }

  const activeNotes = showArchived ? archivedNotes : liveNotes
  const hasMore = showArchived ? archivedHasMore : liveHasMore
  const allTags = Array.from(new Set(activeNotes.flatMap(n => n.tags || []))).sort()

  const filteredNotes = activeNotes.filter(n => {
    const matchesSearch =
      !search ||
      n.title.toLowerCase().includes(search.toLowerCase()) ||
      n.content.toLowerCase().includes(search.toLowerCase())
    const matchesTag = selectedTag ? n.tags?.includes(selectedTag) : true
    return matchesSearch && matchesTag
  })

  return (
    <div className="animate-fade-in h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-semibold">Notes</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={refresh} title="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        {!showArchived && (
          <Button onClick={createNote} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            New Note
          </Button>
        )}
      </div>

      {/* Filters row */}
      <div className="flex flex-col sm:flex-row gap-4 mb-4 shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={showArchived ? 'Search archived notes…' : 'Search notes…'}
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0 no-scrollbar">
          {/* Archive toggle */}
          <Button
            variant={showArchived ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => handleShowArchived(!showArchived)}
            className={cn(
              'text-xs h-8 whitespace-nowrap shrink-0',
              showArchived && 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20',
            )}
          >
            <Archive className="h-3 w-3 mr-1.5 opacity-70" />
            Archived
          </Button>

          {/* Tag filters for current view */}
          {allTags.length > 0 && (
            <>
              <div className="w-px h-4 bg-border shrink-0" />
              <Button
                variant={selectedTag === null ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setSelectedTag(null)}
                className="text-xs h-8 shrink-0"
              >
                All
              </Button>
              {allTags.map(tag => (
                <Button
                  key={tag}
                  variant={selectedTag === tag ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                  className={cn('text-xs h-8 whitespace-nowrap', selectedTag === tag && 'bg-primary/10 text-primary hover:bg-primary/20')}
                >
                  <TagIcon className="h-3 w-3 mr-1.5 opacity-70" />
                  {tag}
                </Button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Archived banner */}
      {showArchived && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-500 text-xs shrink-0">
          <Archive className="h-3.5 w-3.5 shrink-0" />
          Archived notes are retained and can be restored at any time.
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Card key={i} className="h-32 animate-pulse bg-muted/20 border-border/50" />
          ))}
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground border-2 border-dashed rounded-xl bg-muted/10">
          <FileText className="h-12 w-12 mb-4 opacity-20" />
          <p>{showArchived ? 'No archived notes.' : 'No notes found.'}</p>
          {(search || selectedTag) && (
            <Button variant="link" onClick={() => { setSearch(''); setSelectedTag(null) }}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
            {filteredNotes.map(note => (
              <NoteCard
                key={note.id}
                note={note}
                onClick={() => nav(`/dashboard/notes/${note.id}`)}
                onDelete={() => handleDelete(note.id)}
                onArchive={() => handleArchive(note)}
                onUnarchive={() => handleUnarchive(note)}
              />
            ))}
          </div>

          {/* Load more — only shown when no active search/tag filter */}
          {hasMore && !search && !selectedTag && (
            <div className="flex justify-center pb-8 shrink-0">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={isLoadingMore}>
                {isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
