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
