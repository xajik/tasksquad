/** Shared status predicates and labels for Action Graph views. */
export const isActiveAttempt = (status: string) => status === 'pending' || status === 'running'

/** The owner must reply or review in the inbox before this assignment can move. */
export const needsOwner = (action: string | null | undefined) => action === 'reply' || action === 'review'

export const goalVerificationLabel = (verification: string) =>
  verification === 'true' ? 'Verified' : verification === 'false' ? 'Not met' : 'Unverified'
