// Stable, first-party link to the newest native macOS DMG. Pages' _redirects
// sends it to the worker (api.tasksquad.ai), which redirects to the current
// `macos-v*` GitHub release asset.
export const MACOS_DOWNLOAD_URL = 'https://tasksquad.ai/download/macos'
export const MACOS_RELEASES_URL = 'https://github.com/xajik/tasksquad/releases?q=macos-v'

// TaskSquad plugin in ChatGPT (backed by the MCP server below).
export const CHATGPT_PLUGIN_URL = 'https://chatgpt.com/plugins/plugin_asdk_app_6acef16012c4819196f4de152ef2ea03'
export const MCP_SERVER_URL = 'https://tasksquad.ai/mcp'
