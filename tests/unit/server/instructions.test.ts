import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadInstructions } from '../../../src/server/instructions.js'

describe('server instructions', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kb-instructions-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('is undefined when KB_INSTRUCTIONS_FILE is not set', () => {
    expect(loadInstructions({})).toBeUndefined()
  })

  it('fails loudly when the configured file is missing', () => {
    expect(() => loadInstructions({ KB_INSTRUCTIONS_FILE: join(tmp, 'nope.md') })).toThrow()
  })

  it('reaches the client through the MCP handshake', async () => {
    const file = join(tmp, 'instructions.md')
    writeFileSync(file, '\nAntes de tocar lógica de negocio, consulta kb_get.\n')

    const server = new McpServer(
      { name: 'kb', version: '0.0.0' },
      { instructions: loadInstructions({ KB_INSTRUCTIONS_FILE: file }) }
    )
    const client = new Client({ name: 'test', version: '0.0.0' })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverT), client.connect(clientT)])

    expect(client.getInstructions()).toBe('Antes de tocar lógica de negocio, consulta kb_get.')
    await client.close()
  })
})
