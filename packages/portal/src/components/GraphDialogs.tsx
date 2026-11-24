import { useState } from 'react'
import type { Agent } from '@/lib/api'
import type { GraphPolicy, GraphSnapshot, GraphSummary } from '@/lib/graph'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { CreateGraph, PolicyFields } from '@/components/GraphCreate'

type Command = (action: string, data?: unknown) => Promise<boolean>

export function CreateGraphDialog({
  open,
  onOpenChange,
  teamId,
  agents,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
  agents: Agent[]
  onCreated: (g: { id: string }) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>New action graph</DialogTitle>
          <DialogDescription>
            Define an observed baseline and measurable success, then assign existing agents.
          </DialogDescription>
        </DialogHeader>
        <CreateGraph
          teamId={teamId}
          agents={agents}
          onCreated={(g) => {
            onOpenChange(false)
            onCreated(g)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

export function CloneDialog({
  source,
  busy,
  error,
  onClose,
  onClone
}: {
  source: GraphSummary | null
  busy: boolean
  error: string
  onClose: () => void
  onClone: (withNodes: boolean) => void
}) {
  return (
    <Dialog
      open={!!source}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className="max-w-[calc(100%_-_2rem)] sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Clone “{source?.title}”</DialogTitle>
          <DialogDescription>
            Create a fresh graph with the same goal, start state, settings and success rule. Results and run
            history are never copied.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Start from the goal with an empty action graph.</p>
            <Button disabled={busy} onClick={() => onClone(false)}>
              Clone without nodes
            </Button>
          </div>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Also copy nodes, actions, plans, resources and tags.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => onClone(true)}>
              Clone with nodes
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
  current,
  isMaintainer,
  busy,
  policy,
  setPolicy,
  agents,
  command
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: GraphSnapshot | null
  isMaintainer: boolean
  busy: boolean
  policy: GraphPolicy
  setPolicy: (p: GraphPolicy) => void
  agents: Agent[]
  command: Command
}) {
  const [closeConfirm, setCloseConfirm] = useState(false),
    [closeError, setCloseError] = useState('')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Graph settings</DialogTitle>
          <DialogDescription>
            {current?.status === 'stopped'
              ? 'This graph is closed. Settings are read-only; clone it from the graphs list to start a new graph.'
              : !isMaintainer
                ? 'Settings are read-only. An owner or maintainer can change this graph.'
                : 'Pause and resolve existing assignments before creating a configuration revision.'}
          </DialogDescription>
        </DialogHeader>
        {current && (
          <div className="flex flex-wrap items-center gap-2">
            {current.status === 'stopped' ? (
              <>
                <span className="rounded border px-2 py-1 text-sm text-muted-foreground">Closed</span>
              </>
            ) : isMaintainer ? (
              <>
                <Button
                  variant="destructive"
                  disabled={busy}
                  title="Close graph permanently: stops all work and cannot be reopened"
                  onClick={() => {
                    setCloseError('')
                    setCloseConfirm(true)
                  }}
                >
                  Close graph
                </Button>
              </>
            ) : null}
          </div>
        )}
        {current && (
          <fieldset disabled={current.status === 'stopped' || !isMaintainer} className="space-y-4">
            <PolicyFields
              value={current.status === 'stopped' || !isMaintainer ? current.config.policy : policy}
              onChange={setPolicy}
              agents={agents}
            />
          </fieldset>
        )}
        {current && isMaintainer && current.status !== 'stopped' && (
          <>
            <Button
              disabled={busy}
              onClick={async () => {
                if (await command('configure', { policy })) onOpenChange(false)
              }}
            >
              Save revision
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => command('reindex')}>
              Rebuild search index
            </Button>
          </>
        )}
        <AlertDialog
          open={closeConfirm}
          onOpenChange={(open) => {
            if (!busy) setCloseConfirm(open)
          }}
        >
          <AlertDialogContent
            className="w-[calc(100%_-_2rem)] max-w-md"
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Close this graph?</AlertDialogTitle>
              <AlertDialogDescription>
                Closing “{current?.title}” is permanent. Work will stop and this graph cannot be reopened.
                You can clone it later to start a new graph.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {closeError && (
              <p role="alert" className="text-sm text-destructive">
                {closeError}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={busy}
                onClick={async (event) => {
                  event.preventDefault()
                  if (busy) return
                  setCloseError('')
                  if (await command('stop')) {
                    setCloseConfirm(false)
                    onOpenChange(false)
                  } else {
                    setCloseError('Could not close this graph. Please try again.')
                  }
                }}
              >
                {busy ? 'Closing…' : 'Close graph'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

export function ResourceDialog({
  open,
  onOpenChange,
  busy,
  command
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  command: Command
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add versioned resource</DialogTitle>
          <DialogDescription>
            Resources are immutable. Add a new version to preserve existing evidence.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            if (await command('resource', Object.fromEntries(f))) onOpenChange(false)
          }}
        >
          <Label className="grid gap-2">
            Title
            <Input name="title" required maxLength={299} />
          </Label>
          <Label className="grid gap-2">
            Description
            <Input name="description" maxLength={299} />
          </Label>
          <Label className="grid gap-2">
            Content
            <Textarea name="body" maxLength={3999} />
          </Label>
          <Label className="grid gap-2">
            Visibility
            <select name="visibility" className="h-9 border rounded bg-background px-2">
              <option value="execution">Execution context</option>
              <option value="private">Private planning</option>
            </select>
          </Label>
          <Button disabled={busy}>Add resource</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
