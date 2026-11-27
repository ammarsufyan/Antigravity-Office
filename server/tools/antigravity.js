/**
 * antigravity.js - Antigravity lifecycle hook payloads -> office events.
 *
 * Antigravity hooks (~/.gemini/config/hooks.json or plugin hooks.json) fire on
 * SessionStart, PreInvocation, PostInvocation, PreToolUse, PostToolUse, and Stop.
 * Payloads are camelCase protojson carrying conversationId, workspacePaths, cwd,
 * transcriptPath, modelName, lastUserInput, and hookEventName.
 */

import { safely, sessionBase, short, toolStatus } from './common.js'

export const id = 'antigravity'
export const label = 'Antigravity'

const MAX_TRACKED = 256
const lastPrompts = new Map()
const openSubagents = new Map()

function remember(map, key, val) {
  if (!map.has(key) && map.size >= MAX_TRACKED) map.delete(map.keys().next().value)
  map.set(key, val)
}

const ROLE_HINTS = [
  [/\b(debug|bug|crash|error|fix)\b/i, 'debugger'],
  [/\b(review|audit|pr)\b/i, 'code-reviewer'],
  [/\b(frontend|ui|css|react|component|layout|browser)\b/i, 'frontend-developer'],
  [/\b(test|spec|coverage|e2e|qa)\b/i, 'test-engineer'],
  [/\b(security|vuln|auth|secret)\b/i, 'security-auditor'],
  [/\b(deploy|ci|docker|infra|devops)\b/i, 'devops-engineer'],
  [/\b(perf|performance|latency|profil)\b/i, 'performance-engineer'],
  [/\b(database|sql|schema|migration)\b/i, 'database-architect'],
  [/\b(architect|design|plan)\b/i, 'architect-reviewer'],
  [/\b(research|explore|survey|search)\b/i, 'Explore'],
]

function mapSubagentRole(typeName, role, prompt) {
  if (typeName === 'research') return 'Explore'
  if (typeName === 'browser') return 'frontend-developer'
  const text = `${typeName ?? ''} ${role ?? ''} ${prompt ?? ''}`
  for (const [re, mapped] of ROLE_HINTS) if (re.test(text)) return mapped
  return 'general-purpose'
}

// Lightweight shell signal classifier so Antigravity run_command triggers Prod Is Down, deploys, tests, and pushes.
// shortcut: handles common single-command deploy/build/test/push patterns; extract shared classifier if multi-segment bash parity is needed
const SIGNAL_PATTERNS = [
  ['deploy', /\b(?:vercel(?:\s+--prod|\s+deploy)|netlify\s+deploy|fly(?:ctl)?\s+deploy|railway\s+up|gcloud\s+(?:run|app|functions)\s+deploy|kubectl\s+(?:apply|rollout)|helm\s+(?:upgrade|install)|terraform\s+apply|pulumi\s+up|wrangler\s+(?:deploy|publish)|firebase\s+deploy|gh\s+release\s+create|docker\s+push|(?:npm|pnpm|yarn)\s+publish)\b/i],
  ['push', /\bgit\s+push\b/i],
  ['test', /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|vitest\b|jest\b|pytest\b|cargo\s+test\b|go\s+test\b|playwright\s+test\b|dotnet\s+test\b)/i],
  ['build', /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|compile)\b|vite\s+build\b|next\s+build\b|\btsc\b|cargo\s+build\b|go\s+build\b|docker\s+build\b|dotnet\s+build\b)/i],
]
const SIGNAL_KINDS = {
  deploy: ['deploy_start', 'deploy_success', 'deploy_fail'],
  build: ['build_start', 'build_ok', 'build_failed'],
  test: ['test_start', 'test_ok', 'test_failed'],
  push: ['push', 'push_done', 'push_failed'],
}

export function classifyCommandSignals(command, phase, error) {
  if (typeof command !== 'string' || !command.trim() || /--(?:dry-run|help|version)\b/.test(command)) return []
  const idx = phase === 'pre' ? 0 : phase === 'fail' ? 2 : 1
  for (const [group, re] of SIGNAL_PATTERNS) {
    if (!re.test(command)) continue
    const sig = { kind: SIGNAL_KINDS[group][idx], command: command.slice(0, 160) }
    if (group === 'push') {
      const m = /\bgit\s+push(?:\s+\S+)?\s+([A-Za-z0-9._/-]+)/.exec(command)
      const branch = m?.[1]?.split(':').pop()?.replace(/^refs\/heads\//, '')
      if (branch && !branch.startsWith('-')) {
        sig.branch = branch.slice(0, 120)
        sig.toDefault = branch === 'main' || branch === 'master'
      }
    }
    if (phase === 'fail' && error) sig.error = String(error).replace(/\s+/g, ' ').trim().slice(0, 200)
    return [sig]
  }
  return []
}

/**
 * @param {object} p  the raw hook payload
 * @param {string} [event]  the hook event name (falls back to payload.hookEventName)
 * @returns {object[]} office events
 */
export function translate(p, event) {
  return safely(() => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return []
    const ev = short(event, 60) || short(p.hookEventName, 60)
    if (!ev) return []
    const sid = short(p.conversationId)
    if (!sid) return []
    const cwd = short(p.cwd, 400) || (Array.isArray(p.workspacePaths) ? short(p.workspacePaths[0], 400) : undefined)
    const base = sessionBase(id, sid, cwd)
    const transcriptPath = short(p.transcriptPath, 400)
    if (transcriptPath) base.transcriptPath = transcriptPath
    const tool = short(p.toolCall?.name, 80)
    const args = p.toolCall?.args && typeof p.toolCall.args === 'object' ? p.toolCall.args : {}
    const out = (type, fields = {}) => ({ ...base, type, ...fields })

    switch (ev) {
      case 'SessionStart':
        lastPrompts.delete(sid)
        openSubagents.delete(sid)
        return [out('session_started', { source: 'startup', model: short(p.modelName, 80) })]

      case 'PreInvocation': {
        const prompt = short(p.lastUserInput, 2000)
        if (prompt && lastPrompts.get(sid) !== prompt) {
          remember(lastPrompts, sid, prompt)
          return [out('session_prompt', { text: prompt, isWakeup: false })]
        }
        return [out('agent_working', { status: 'thinking' })]
      }

      case 'PostInvocation':
        return []

      case 'PreToolUse': {
        if (tool === 'call_mcp_tool') {
          const server = short(args.ServerName, 80)
          const mcpTool = short(args.ToolName, 80)
          if (server) return [out('mcp_call', { server, tool: mcpTool || 'tool' })]
        }
        if (tool === 'invoke_subagent') {
          const subId = `antigravity:${short(p.toolCall?.id, 60) || `step-${p.stepIdx ?? Date.now()}`}`
          const name = short(args.Role, 60) || short(args.TypeName, 60) || 'Subagent'
          const role = mapSubagentRole(args.TypeName, args.Role, args.Prompt)
          const tracked = openSubagents.get(sid) ?? new Set()
          tracked.add(subId)
          remember(openSubagents, sid, tracked)
          return [out('agent_spawned', {
            agent: { id: subId, name, role, task: short(args.Prompt, 200) || name, background: true },
          })]
        }
        const events = []
        if (tool === 'update_steps' && Array.isArray(args.steps)) {
          events.push(out('task_board_sync', { steps: args.steps }))
        }
        const signals = tool === 'run_command' ? classifyCommandSignals(args.CommandLine, 'pre') : []
        events.push(out('agent_working', {
          status: toolStatus(tool, args),
          tool,
          ...(signals.length ? { signals } : {}),
        }))
        return events
      }

      case 'PostToolUse': {
        const error = short(p.error, 120)
        if (tool === 'call_mcp_tool') {
          const server = short(args.ServerName, 80)
          if (server) return [out('mcp_done', { server, tool: short(args.ToolName, 80) || 'tool' })]
        }
        if (tool === 'invoke_subagent') {
          const subId = `antigravity:${short(p.toolCall?.id, 60) || `step-${p.stepIdx ?? Date.now()}`}`
          if (error) {
            openSubagents.get(sid)?.delete(subId)
            return [out('agent_completed', { agentId: subId, result: `failed: ${error}` })]
          }
          const tracked = openSubagents.get(sid) ?? new Set()
          if (!tracked.has(subId)) {
            tracked.add(subId)
            remember(openSubagents, sid, tracked)
            const name = short(args.Role, 60) || short(args.TypeName, 60) || 'Subagent'
            const role = mapSubagentRole(args.TypeName, args.Role, args.Prompt)
            return [
              out('agent_spawned', { agent: { id: subId, name, role, task: short(args.Prompt, 200) || name, background: true } }),
              out('session_tool_done', { toolName: tool }),
            ]
          }
          return [out('session_tool_done', { toolName: tool })]
        }
        if (tool === 'manage_subagents' && args.Action === 'kill_all') {
          const tracked = openSubagents.get(sid)
          openSubagents.delete(sid)
          const done = tracked ? [...tracked].map(agentId => out('agent_completed', { agentId, result: 'stopped' })) : []
          return [...done, out('session_tool_done', { toolName: tool })]
        }
        const signals = tool === 'run_command' ? classifyCommandSignals(args.CommandLine, error ? 'fail' : 'ok', error) : []
        if (error) {
          return [out('agent_working', {
            status: `failed: ${tool ?? 'tool'} — ${error}`,
            failed: true,
            tool,
            ...(signals.length ? { signals } : {}),
          })]
        }
        const events = [out('session_tool_done', { toolName: tool, ...(signals.length ? { signals } : {}) })]
        if (tool === 'update_steps' && Array.isArray(args.steps)) {
          events.push(out('task_board_sync', { steps: args.steps }))
        }
        if (tool) events.push(out('agent_working', { status: toolStatus(tool, args), tool }))
        return events
      }

      case 'Stop': {
        lastPrompts.delete(sid)
        const events = []
        if (p.fullyIdle === true && openSubagents.has(sid)) {
          for (const agentId of openSubagents.get(sid)) {
            events.push(out('agent_completed', { agentId, result: 'done' }))
          }
          openSubagents.delete(sid)
        }
        if (short(p.error)) {
          events.push(out('session_error', { error: 'agy_error', detail: short(p.error) }))
        } else {
          events.push(out('session_turn_end', {}))
        }
        return events
      }

      default:
        return []
    }
  })
}

export default { id, label, translate }
