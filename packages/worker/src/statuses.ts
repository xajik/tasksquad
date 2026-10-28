export const TaskStatus = {
  Pending:      'pending',
  Running:      'running',
  WaitingInput: 'waiting_input',
  WrappingUp:   'wrapping_up',
  Done:         'done',
  Failed:       'failed',
  Scheduled:    'scheduled',
  Cancelled:    'cancelled',
} as const

export type TaskStatusValue = typeof TaskStatus[keyof typeof TaskStatus]

export const AgentStatus = {
  Offline:      'offline',
  Idle:         'idle',
  Running:      'running',
  WaitingInput: 'waiting_input',
  WrappingUp:   'wrapping_up',
} as const

export type AgentStatusValue = typeof AgentStatus[keyof typeof AgentStatus]

export const SessionStatus = {
  Running:      'running',
  WaitingInput: 'waiting_input',
  Closed:       'closed',
  // The CLI process went away while the task was waiting for input (or a
  // resumed process failed to start). The task stays open; the next user reply
  // re-spawns it, resuming the provider session when one was reported.
  Detached:     'detached',
} as const

export type SessionStatusValue = typeof SessionStatus[keyof typeof SessionStatus]

export const AgentMode = {
  Idle:         'idle',
  Accumulating: 'accumulating',
  Running:      'running',
  WaitingInput: 'waiting_input',
  WrappingUp:   'wrapping_up',
} as const

export type AgentModeValue = typeof AgentMode[keyof typeof AgentMode]

export const MessageType = {
  Thinking:        'thinking',
  ToolCall:        'tool_call',
  ToolResult:      'tool_result',
  Output:          'output',
  PermissionRequest: 'permission_request',
  NoteToInbox:     'note-to-inbox',
  NoteCritique:    'note-critique',
  Inbox:           'inbox',
  Conveyor:        'conveyor',
} as const

export type MessageTypeValue = typeof MessageType[keyof typeof MessageType]
