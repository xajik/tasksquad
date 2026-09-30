// Stable link to the newest native macOS DMG; the worker redirects it to the
// current `macos-v*` GitHub release asset.
export const MACOS_DOWNLOAD_URL = `${import.meta.env.VITE_API_BASE_URL}/download/macos`
export const MACOS_RELEASES_URL = 'https://github.com/xajik/tasksquad/releases?q=macos-v'
