/** The API client throws parsed JSON bodies, not Error instances. */
export const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'error' in error
      ? String((error as { error: unknown }).error)
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
