export const MessageType = {
  Thinking:          'thinking',
  ToolCall:          'tool_call',
  ToolResult:        'tool_result',
  Output:            'output',
  PermissionRequest: 'permission_request',
  NoteToInbox:       'note-to-inbox',
  NoteCritique:      'note-critique',
} as const

export type MessageTypeValue = typeof MessageType[keyof typeof MessageType]