import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { api, type Note, type NoteComment, type Agent, type Member, type LinkedTask } from '../lib/api'
import { auth } from '../lib/firebase'
import { trackEvent } from '../lib/analytics'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  ArrowLeft, Trash2, Tag as TagIcon, Send,
  MessageSquare, Loader2, X,
  Bold, Italic, Strikethrough, Code, Code2, List, ListOrdered,
  ListTodo, Quote, Minus, Undo, Redo, Heading1, Heading2, Heading3,
  Link2, CheckCircle2, Clock, XCircle, CircleDot, Archive, ArchiveRestore,
} from 'lucide-react'
import { cn } from '@/lib/utils'

function useDebounceValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])
  return debouncedValue
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function ToolbarBtn({
  onClick, active, title, disabled, children,
}: {
  onClick: () => void; active?: boolean; title: string; disabled?: boolean; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={e => { e.preventDefault(); onClick() }}
      disabled={disabled}
      title={title}
      className={cn(
        'h-7 w-7 flex items-center justify-center rounded transition-colors',
        active ? 'bg-primary/10 text-primary' : 'text-foreground/50 hover:bg-muted hover:text-foreground',
        disabled && 'opacity-25 pointer-events-none',
      )}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-4 bg-border mx-0.5 shrink-0" />
}

function EditorToolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 border-b bg-muted/20 shrink-0">
      <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo">
        <Undo className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo">
        <Redo className="h-3.5 w-3.5" />
      </ToolbarBtn>

      <Divider />

      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Heading 1">
        <Heading1 className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Heading 2">
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Heading 3">
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarBtn>

      <Divider />

      <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold (Ctrl+B)">
        <Bold className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic (Ctrl+I)">
        <Italic className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough">
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive('code')} title="Inline Code">
        <Code className="h-3.5 w-3.5" />
      </ToolbarBtn>

      <Divider />

      <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List">
        <List className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Ordered List">
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive('taskList')} title="Task List">
        <ListTodo className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} title="Blockquote">
        <Quote className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} title="Code Block">
        <Code2 className="h-3.5 w-3.5" />
      </ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal Rule">
        <Minus className="h-3.5 w-3.5" />
      </ToolbarBtn>
    </div>
  )
}

// ─── Rich Text Editor ─────────────────────────────────────────────────────────

function RichTextEditor({ content, onChange }: { content: string; onChange: (md: string) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Write something…' }),
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content,
    editorProps: {
      // Suppress Grammarly — it conflicts with ProseMirror's DOM management
      attributes: {
        class: 'outline-none min-h-[300px]',
        'data-gramm': 'false',
        'data-gramm_editor': 'false',
        'data-enable-grammarly': 'false',
      },
    },
    onUpdate: ({ editor }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onChange((editor.storage as any).markdown.getMarkdown())
    },
  })

  if (!editor) return null

  return (
    <div className="flex flex-col flex-1 h-full overflow-hidden">
      <EditorToolbar editor={editor} />
      <div
        className="flex-1 overflow-auto p-4 sm:p-6 cursor-text text-sm leading-relaxed"
        onClick={() => editor.commands.focus()}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

// ─── Note-to-Inbox Dialog ─────────────────────────────────────────────────────

function NoteToInboxDialog({ noteId, teamId, isOpen, onOpenChange, onSuccess }: {
  noteId: string; teamId: string; isOpen: boolean; onOpenChange: (open: boolean) => void; onSuccess?: () => void
}) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [includeComments, setIncludeComments] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (isOpen) api.agents.list(teamId).then(d => setAgents(d.agents ?? []))
  }, [isOpen, teamId])

  async function handleSend() {
    if (!agentId) return
    setSending(true)
    try {
      await api.notes.convertToInbox(teamId, noteId, { agent_id: agentId, include_comments: includeComments, instructions })
      trackEvent('note_to_inbox', { team_id: teamId, agent_id: agentId })
      onOpenChange(false)
      onSuccess?.()
    } catch (e) {
      console.error(e)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Send to Inbox</DialogTitle>
          <DialogDescription>Create a task for an agent using this note as context.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger><SelectValue placeholder="Select agent..." /></SelectTrigger>
              <SelectContent>
                {agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="include-comments"
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              checked={includeComments}
              onChange={e => setIncludeComments(e.target.checked)}
            />
            <Label htmlFor="include-comments" className="font-normal cursor-pointer">Include comments in context</Label>
          </div>
          <div className="grid gap-2">
            <Label>Instructions (Optional)</Label>
            <Textarea
              placeholder="e.g. Summarize this note, or Turn these bullet points into a report..."
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSend} disabled={!agentId || sending}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
            Send Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Note Detail ──────────────────────────────────────────────────────────────

export function NoteDetail({ teamId }: { teamId: string }) {
  const { noteId } = useParams<{ noteId: string }>()
  const nav = useNavigate()

  const [note, setNote] = useState<Note | null>(null)
  const [content, setContent] = useState('')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')

  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [showInboxDialog, setShowInboxDialog] = useState(false)
  const [showMobileComments, setShowMobileComments] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'comments' | 'tasks'>('comments')

  // Comments
  const [comments, setComments] = useState<NoteComment[]>([])
  const [newComment, setNewComment] = useState('')
  const [loadingComments, setLoadingComments] = useState(false)
  const [postingComment, setPostingComment] = useState(false)

  // Linked tasks
  const [linkedTasks, setLinkedTasks] = useState<LinkedTask[]>([])
  const [loadingLinkedTasks, setLoadingLinkedTasks] = useState(false)

  // Members for author display
  const [members, setMembers] = useState<Member[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  const debouncedContent = useDebounceValue(content, 1000)
  const debouncedTitle = useDebounceValue(title, 1000)

  const load = useCallback(async () => {
    if (!noteId) return
    try {
      const n = await api.notes.get(teamId, noteId)
      setNote(n)
      setTitle(n.title)
      setContent(n.content)
      setTags(n.tags || [])
      setLastSaved(Date.now())
    } catch {
      nav('/dashboard/notes')
    }
  }, [teamId, noteId, nav])

  const loadComments = useCallback(async () => {
    if (!noteId) return
    setLoadingComments(true)
    try {
      const d = await api.notes.listComments(teamId, noteId)
      setComments(d.comments)
    } finally {
      setLoadingComments(false)
    }
  }, [teamId, noteId])

  const loadLinkedTasks = useCallback(async () => {
    if (!noteId) return
    setLoadingLinkedTasks(true)
    try {
      const d = await api.notes.listLinkedTasks(teamId, noteId)
      setLinkedTasks(d.tasks)
    } finally {
      setLoadingLinkedTasks(false)
    }
  }, [teamId, noteId])

  useEffect(() => {
    load()
    loadComments()
    loadLinkedTasks()
    api.members.list(teamId).then(d => setMembers(d.members ?? []))
    api.me().then(u => setCurrentUserId(u.id)).catch(() => {})
  }, [load, loadComments, loadLinkedTasks, teamId])

  // Auto-save
  useEffect(() => {
    if (!note || !noteId) return
    if (title === note.title && content === note.content) return
    if (debouncedTitle !== title || debouncedContent !== content) return

    const save = async () => {
      setSaving(true)
      try {
        await api.notes.update(teamId, noteId, { title, content })
        setNote(prev => prev ? { ...prev, title, content } : null)
        setLastSaved(Date.now())
      } finally {
        setSaving(false)
      }
    }
    save()
  }, [debouncedTitle, debouncedContent, title, content, note, teamId, noteId])

  const addTag = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault()
      const newTag = tagInput.trim()
      if (!tags.includes(newTag)) {
        const newTags = [...tags, newTag]
        setTags(newTags)
        setTagInput('')
        await api.notes.update(teamId, noteId!, { tags: newTags })
      }
    }
  }

  const removeTag = async (tagToRemove: string) => {
    const newTags = tags.filter(t => t !== tagToRemove)
    setTags(newTags)
    await api.notes.update(teamId, noteId!, { tags: newTags })
  }

  const deleteNote = async () => {
    await api.notes.delete(teamId, noteId!)
    nav('/dashboard/notes')
  }

  const archiveNote = async () => {
    await api.notes.archive(teamId, noteId!)
    trackEvent('note_archived', { team_id: teamId })
    nav('/dashboard/notes')
  }

  const unarchiveNote = async () => {
    await api.notes.unarchive(teamId, noteId!)
    trackEvent('note_unarchived', { team_id: teamId })
    setNote(prev => prev ? { ...prev, archived_at: null } : null)
  }

  const deleteComment = async (commentId: string) => {
    await api.notes.deleteComment(teamId, noteId!, commentId)
    setComments(prev => prev.filter(c => c.id !== commentId))
  }

  const postComment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newComment.trim()) return
    setPostingComment(true)
    try {
      const c = await api.notes.createComment(teamId, noteId!, newComment)
      setComments(prev => [...prev, c])
      setNewComment('')
      trackEvent('note_comment_added', { team_id: teamId })
    } finally {
      setPostingComment(false)
    }
  }

  const authorLabel = (authorId: string): string => {
    if (authorId === currentUserId) {
      return auth.currentUser?.displayName || auth.currentUser?.email || 'You'
    }
    return members.find(m => m.id === authorId)?.email ?? 'Unknown'
  }

  const commentsPanelJsx = (
    <>
      <ScrollArea className="flex-1 p-4">
        {loadingComments ? (
          <Loader2 className="animate-spin mx-auto mt-4" />
        ) : (
          <div className="space-y-4">
            {comments.map(c => (
              <div key={c.id} className="text-sm group">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-xs text-foreground/70">{authorLabel(c.author_id)}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(c.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {c.author_id === currentUserId && (
                      <button
                        onClick={() => deleteComment(c.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive ml-1"
                        title="Delete comment"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="bg-background border rounded-lg p-2 text-foreground/90">{c.content}</div>
              </div>
            ))}
            {comments.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No comments yet.</p>
            )}
          </div>
        )}
      </ScrollArea>
      <form onSubmit={postComment} className="p-3 border-t bg-background shrink-0">
        <Textarea
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          placeholder="Add a comment..."
          className="min-h-[80px] mb-2 text-xs"
        />
        <Button size="sm" className="w-full" disabled={postingComment || !newComment.trim()}>
          Post Comment
        </Button>
      </form>
    </>
  )

  function taskStatusIcon(status: string) {
    switch (status) {
      case 'completed': return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
      case 'failed':    return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
      case 'in_progress': return <CircleDot className="h-3.5 w-3.5 text-primary shrink-0" />
      default:          return <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    }
  }

  const linkedTasksPanelJsx = (
    <ScrollArea className="flex-1 p-4">
      {loadingLinkedTasks ? (
        <Loader2 className="animate-spin mx-auto mt-4" />
      ) : linkedTasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
          <Link2 className="h-8 w-8 mb-2 opacity-20" />
          <p className="text-xs">No tasks from this note yet.</p>
          <p className="text-[11px] mt-1 opacity-70">Use "To Inbox" to create one.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {linkedTasks.map(t => (
            <button
              key={t.id}
              className="w-full text-left rounded-lg border bg-background hover:border-primary/50 hover:bg-muted/30 transition-colors p-2.5 group"
              onClick={() => nav(`/dashboard/tasks/${t.id}`)}
            >
              <div className="flex items-start gap-2">
                {taskStatusIcon(t.status)}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium line-clamp-2 group-hover:text-primary transition-colors">{t.subject}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    {t.agent_name && (
                      <span className="text-[10px] text-muted-foreground truncate">{t.agent_name}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">
                      {new Date(t.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </ScrollArea>
  )

  if (!note) return <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin" /></div>

  return (
    <div className="flex flex-col h-full overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between py-2 border-b shrink-0 px-1 gap-4">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Button variant="ghost" size="icon" onClick={() => nav('/dashboard/notes')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Input
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="text-lg font-bold border-none shadow-none focus-visible:ring-0 px-0 h-auto py-1"
            placeholder="Untitled Note"
            readOnly={!!note?.archived_at}
          />
          {note?.archived_at && (
            <Badge variant="secondary" className="shrink-0 bg-amber-500/10 text-amber-600 border-amber-500/20 text-[10px]">
              Archived
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-muted-foreground mr-2 hidden sm:inline">
            {saving ? 'Saving…' : lastSaved ? 'Saved' : ''}
          </span>

          {/* Mobile-only panel button */}
          <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden relative" onClick={() => { setSidebarTab('comments'); setShowMobileComments(true) }} title="Comments">
            <MessageSquare className="h-4 w-4" />
            {comments.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-[9px] text-primary-foreground flex items-center justify-center font-bold">
                {comments.length > 9 ? '9+' : comments.length}
              </span>
            )}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden relative" onClick={() => { setSidebarTab('tasks'); setShowMobileComments(true) }} title="Linked tasks">
            <Link2 className="h-4 w-4" />
            {linkedTasks.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-[9px] text-primary-foreground flex items-center justify-center font-bold">
                {linkedTasks.length > 9 ? '9+' : linkedTasks.length}
              </span>
            )}
          </Button>

          {!note?.archived_at && (
            <Button variant="outline" size="sm" onClick={() => setShowInboxDialog(true)}>
              <Send className="h-3.5 w-3.5 mr-1.5" />
              To Inbox
            </Button>
          )}

          {/* Archive / Unarchive */}
          {note?.archived_at ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-amber-600 hover:bg-amber-500/10" title="Unarchive note" onClick={unarchiveNote}>
              <ArchiveRestore className="h-4 w-4" />
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:bg-muted" title="Archive note">
                  <Archive className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Archive Note</AlertDialogTitle>
                  <AlertDialogDescription>
                    This note will be archived. You can restore it at any time from the Archived filter.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={archiveNote}>Archive</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Note</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete "{title}"? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={deleteNote}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Main Content Area */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Tags Bar */}
          <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/10 shrink-0 overflow-x-auto no-scrollbar">
            <TagIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {tags.map(tag => (
              <Badge key={tag} variant="secondary" className="h-5 px-1.5 text-[10px] gap-1 cursor-default">
                {tag}
                <button onClick={() => removeTag(tag)} className="hover:text-destructive"><span className="sr-only">Remove</span>×</button>
              </Badge>
            ))}
            <input
              className="bg-transparent border-none text-xs focus:outline-none min-w-[60px]"
              placeholder="Add tag…"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={addTag}
            />
          </div>

          {/* Editor or Preview */}
          <div className="flex-1 overflow-hidden">
            <div className="h-full flex flex-col overflow-hidden">
              <RichTextEditor content={content} onChange={setContent} />
            </div>
          </div>
        </div>

        {/* Sidebar — desktop only */}
        <div className="w-80 border-l bg-muted/5 flex-col shrink-0 hidden lg:flex">
          {/* Tab header */}
          <div className="flex border-b shrink-0">
            <button
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors',
                sidebarTab === 'comments'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setSidebarTab('comments')}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Comments
              {comments.length > 0 && (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{comments.length}</Badge>
              )}
            </button>
            <button
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors',
                sidebarTab === 'tasks'
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setSidebarTab('tasks')}
            >
              <Link2 className="h-3.5 w-3.5" />
              Tasks
              {linkedTasks.length > 0 && (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{linkedTasks.length}</Badge>
              )}
            </button>
          </div>
          {sidebarTab === 'comments' ? commentsPanelJsx : linkedTasksPanelJsx}
        </div>
      </div>

      {/* Mobile sidebar dialog */}
      <Dialog open={showMobileComments} onOpenChange={setShowMobileComments}>
        <DialogContent className="h-[85dvh] flex flex-col p-0 gap-0 sm:max-w-md">
          <DialogHeader className="p-0 shrink-0">
            <DialogTitle className="sr-only">Note panel</DialogTitle>
            <div className="flex border-b">
              <button
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-medium transition-colors',
                  sidebarTab === 'comments'
                    ? 'border-b-2 border-primary text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setSidebarTab('comments')}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Comments
                {comments.length > 0 && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{comments.length}</Badge>
                )}
              </button>
              <button
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-medium transition-colors',
                  sidebarTab === 'tasks'
                    ? 'border-b-2 border-primary text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setSidebarTab('tasks')}
              >
                <Link2 className="h-3.5 w-3.5" />
                Tasks
                {linkedTasks.length > 0 && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{linkedTasks.length}</Badge>
                )}
              </button>
            </div>
          </DialogHeader>
          <div className="flex flex-col flex-1 min-h-0">
            {sidebarTab === 'comments' ? commentsPanelJsx : linkedTasksPanelJsx}
          </div>
        </DialogContent>
      </Dialog>

      <NoteToInboxDialog
        noteId={noteId!}
        teamId={teamId}
        isOpen={showInboxDialog}
        onOpenChange={setShowInboxDialog}
        onSuccess={() => { loadLinkedTasks(); setSidebarTab('tasks') }}
      />
    </div>
  )
}
