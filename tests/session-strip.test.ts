/** SessionStrip — an Antigravity session carries a tag naming the tool; direct /event sessions have none. */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SessionStrip from '../src/components/SessionStrip'
import { clientOf } from '../src/tools'

const render = (sessions: any[]) => renderToStaticMarkup(React.createElement(SessionStrip, { sessions, agents: [] } as any))

describe('SessionStrip tool tag', () => {
  it('tags an Antigravity session, and names the tool in its hover text', () => {
    const html = render([{ id: 'antigravity:abc', client: 'antigravity', project: 'demo', state: 'active' }])
    expect(html).toMatch(/class="session-pill-client"[^>]*>Antigravity</)
    expect(html).toContain('tool: Antigravity')
  })

  it('works out the tool from the id when the session has no client field', () => {
    expect(render([{ id: 'antigravity:abc', project: 'demo', state: 'active' }])).toMatch(/session-pill-client[^>]*>Antigravity</)
  })

  it('leaves a direct /event session without a tag', () => {
    const html = render([{ id: '5f0c3b1e-direct', project: 'demo', state: 'active' }])
    expect(html).not.toContain('session-pill-client')
    expect(html).not.toContain('tool:')
  })
})

describe('clientOf', () => {
  it('reads the tool from the session id prefix, or the explicit client', () => {
    expect(clientOf('antigravity:1')).toBe('antigravity')
    expect(clientOf('5f0c3b1e')).toBeUndefined()
    expect(clientOf('weird:1')).toBeUndefined()
    expect(clientOf('x', 'antigravity')).toBe('antigravity')
  })
})
