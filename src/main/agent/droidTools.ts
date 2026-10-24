import {
  createSdkMcpServer,
  tool,
  type DroidTool,
  type DroidToolResult,
  type SdkMcpServer
} from '@factory/droid-sdk/node'
import type { ToolDef } from '../tools/types'
import { performCall } from './calls'
import { SERVER_NAME } from './toolNames'
import type { RunContext } from './types'

const failure = (text: string): DroidToolResult => ({ content: [{ type: 'text', text }], isError: true })

/**
 * Wraps each ToolDef as an SDK tool. The handler is the single place a tool runs
 * during an agent turn, so it records evidence into the current run and refuses
 * to run when there is no live run or a write call lacks the user's approval.
 */
export function buildDroidTools(tools: readonly ToolDef[], currentRun: () => RunContext | null): DroidTool[] {
  return tools.map((def) =>
    tool(
      def.name,
      def.description,
      def.schema,
      async (args): Promise<DroidToolResult> => {
        const run = currentRun()
        if (!run || run.stopped) return failure('Stopped by the user.')
        if (def.risk === 'write' && !run.takeApproval(def.name)) {
          return failure('The user has not confirmed this action.')
        }
        const outcome = await performCall(run, def, args, () => def.run(args))
        return outcome.ok ? outcome.text : failure(outcome.text)
      },
      { annotations: { readOnlyHint: def.risk === 'read', destructiveHint: def.risk === 'write' } }
    )
  )
}

/** The loopback MCP server Droid connects to; it starts with the session and stops on `session.close()`. */
export function createFastaslServer(tools: DroidTool[]): SdkMcpServer {
  return createSdkMcpServer({ name: SERVER_NAME, tools })
}
