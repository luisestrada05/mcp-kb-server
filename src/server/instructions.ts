import { readFileSync } from 'node:fs'

/**
 * Server instructions — the MCP `instructions` field, which clients such as
 * Claude Code inject into the agent's context. It is how a knowledge base
 * tells the agent *when* to consult it ("before changing business logic,
 * fetch the rule and honor its No significa"), without editing each repo's
 * CLAUDE.md or Copilot instructions.
 *
 * The text belongs to the content repo (each business words its own), so it
 * is read from the file named by KB_INSTRUCTIONS_FILE. A configured file that
 * cannot be read is a startup error, not a silent fallback: the operator asked
 * for instructions and would otherwise never notice they are missing.
 */
export function loadInstructions(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.KB_INSTRUCTIONS_FILE
  if (!file) return undefined
  const text = readFileSync(file, 'utf-8').trim()
  return text || undefined
}
