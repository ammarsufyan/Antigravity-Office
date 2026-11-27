/** tools - hook clients the office displays (server/tools). */

/**
 * Tool id -> display name; mirrors server/tools.
 * Kept here so the UI bundle does not import server code.
 */
export const CLIENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  antigravity: 'Antigravity',
})

/**
 * Which tool a session is: its explicit `client`, else the prefix the server
 * gives hook-translated session ids ("antigravity:<id>").
 */
export function clientOf(sessionId: string | undefined, client?: string): string | undefined {
  if (client && Object.prototype.hasOwnProperty.call(CLIENT_LABELS, client)) return client
  const prefix = sessionId?.split(':', 1)[0]
  return prefix && sessionId!.includes(':') && Object.prototype.hasOwnProperty.call(CLIENT_LABELS, prefix) ? prefix : undefined
}

/** The tool's display name for a session, or undefined for direct /event sessions. */
export function clientLabel(sessionId: string | undefined, client?: string): string | undefined {
  const id = clientOf(sessionId, client)
  return id ? CLIENT_LABELS[id] : undefined
}
