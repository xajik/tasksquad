/** Commands that stay available while Action Graph dispatch is disabled (they only wind work down). */
export const COMMANDS_WHEN_DISABLED: readonly string[] = [
  'tick',
  'pause',
  'stop',
  'review',
  'input',
  'fail',
  'abandon',
  'retry_review',
  'cancel_review'
]
