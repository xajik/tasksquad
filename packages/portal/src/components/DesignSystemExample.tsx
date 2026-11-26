import { useState } from 'react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger
} from './ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from './ui/alert-dialog'

const initialTitle = 'Release checklist'

/** Public, local-only examples using the same controls as the portal. */
export function DesignSystemExample() {
  const [title, setTitle] = useState(initialTitle)
  const [draft, setDraft] = useState(title)
  const [editing, setEditing] = useState(false)
  const [closed, setClosed] = useState(false)
  const [range, setRange] = useState('week')

  return (
    <section aria-label="Sample graph controls" className="my-5 space-y-4 rounded-lg border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <strong className="break-words text-base">{title}</strong>
        <Badge variant="secondary">{closed ? 'Closed' : 'Running'}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger aria-label="Sample score period" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="week">Last 7 days</SelectItem>
            <SelectItem value="month">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
        <Popover>
          <PopoverTrigger asChild><Button variant="outline">Goal score</Button></PopoverTrigger>
          <PopoverContent aria-label="Sample goal score" className="max-w-[calc(100vw-2rem)] text-sm">
            <strong>{range === 'week' ? '0.80 · Last 7 days' : '0.65 · Last 30 days'}</strong>
            <p className="mt-2">The score measures how far the observed result advanced this example goal, on a scale from 0 to 1.</p>
          </PopoverContent>
        </Popover>
        <Dialog open={editing} onOpenChange={(open) => { if (open) setDraft(title); setEditing(open) }}>
          <DialogTrigger asChild><Button variant="outline" disabled={closed}>Rename</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename sample graph</DialogTitle>
              <DialogDescription>The name appears on the example card.</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={(event) => {
              event.preventDefault()
              if (draft.trim()) { setTitle(draft.trim()); setEditing(false) }
            }}>
              <div className="space-y-2">
                <Label htmlFor="sample-graph-title">Graph name</Label>
                <Input id="sample-graph-title" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={80} required />
              </div>
              <DialogFooter>
                <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
                <Button type="submit" disabled={!draft.trim()}>Save name</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" onClick={(event) => {
              if (closed) {
                event.preventDefault()
                setClosed(false)
                setTitle(initialTitle)
                setRange('week')
              }
            }}>{closed ? 'Reset example' : 'Close graph'}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Close {title}?</AlertDialogTitle>
              <AlertDialogDescription>Closing this sample graph ends its run. You can reset the example to try it again.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep open</AlertDialogCancel>
              <AlertDialogAction onClick={() => setClosed(true)}>Close graph</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  )
}
