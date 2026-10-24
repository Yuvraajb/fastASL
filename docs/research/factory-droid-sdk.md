# Factory Droid TypeScript SDK: Verified API Reference

Package: **`@factory/droid-sdk@0.10.0`** (latest, published 2026-10-19). Researched 2026-10-24.

## How this was verified

| Source | What it covered |
| --- | --- |
| `https://docs.factory.com/sdk/typescript.md` (raw markdown, 1,470 lines, read in full) | The canonical guide. All SDK docs are on this one page; `llms.txt` lists no other TypeScript SDK sub-pages. |
| `https://docs.factory.com/llms.txt` | Page index. SDK-related pages: `/sdk/typescript.md`, `/sdk/python.md`, `/droid-exec/overview.md`, `/api-reference/sessions.md` |
| `/droid-exec/overview.md`, `/droid-cli/quickstart.md` | CLI install commands and the API key page |
| `npm view` + `npm pack` | Read `package.json`, `README.md`, `dist/node.d.ts` (all 846 lines), the relevant parts of the bundled `dist/index-DWBA4zgW.d.ts` (174k lines), the runtime JS (`dist/node.mjs`, `dist/chunk-TWAVPIPS.mjs`), and `examples/node/*.ts` |
| Compile check | The example in section 13 compiles with `tsc --noEmit` and `strict` under `moduleResolution: node16` (CJS emit) and `bundler`. It also compiles with TS 5.7.3 and `skipLibCheck: false`. |
| Runtime check (CJS `require`) | Every export named below exists at runtime. I also checked what happens with no API key, with no droid binary, and what config the SDK MCP server produces. |

Extracted package (for further inspection): `/private/tmp/claude-501/-Users-kc-fastASL/65b0677c-1e10-4d3b-9147-d2db7a3883e6/scratchpad/droid-pkg/extracted/package/`
Compile-verified example project: `/private/tmp/claude-501/-Users-kc-fastASL/65b0677c-1e10-4d3b-9147-d2db7a3883e6/scratchpad/droid-verify/src/droid-agent.ts`

**Not run:** no live agent turn was executed. The `droid` CLI is **not installed** on this machine (`which droid` returns "droid not found"), and no `FACTORY_API_KEY` was available. Everything about live behavior comes from the docs and from reading the SDK source.

---

## 1. Package facts

```
name:      @factory/droid-sdk
version:   0.10.0   (dist-tags: { latest: "0.10.0" })
versions:  0.1.1 … 0.9.0, 0.9.1, 0.10.0
license:   Apache-2.0
repo:      https://github.com/Factory-AI/droid-sdk-typescript
engines:   { node: ">=18.0.0" }
peerDependencies: none
dependencies:
  @modelcontextprotocol/sdk ^1.29.0   (resolved 1.32.2)
  @opentelemetry/api ^1.9.0
  eventemitter3 ^5.0.1
  fast-deep-equal ^3.1.3
  isows ^1.0.7
  libsodium-wrappers-sumo ^0.8.4
  uuid ^9.0.0
  ws ^8.21.0
  zod ^3.24.0                          (resolved 3.25.76)
```

**Exports map. The package is dual CJS/ESM, not ESM-only:**

```json
".":     { "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
           "require": { "types": "./dist/index.d.ts",  "default": "./dist/index.js" } },
"./node": { "import": { "types": "./dist/node.d.mts", "default": "./dist/node.mjs" },
            "require": { "types": "./dist/node.d.ts",  "default": "./dist/node.js" } }
```

- **`@factory/droid-sdk/node`** is the entrypoint to use in the Electron main process. It spawns droid subprocesses and provides `run`, `createSession`, `resumeSession`, `listSessions`, `listModels`, `tool`, and `createSdkMcpServer`.
- `@factory/droid-sdk` (root) is for browser or Node clients that connect to an existing Droid daemon (`connectToDaemon()`). You don't need it for this use case.
- Both `require('@factory/droid-sdk/node')` and `import` work at runtime. I verified both.

**TypeScript gotchas (verified):**
- `moduleResolution` must be **`node16`, `nodenext`, or `bundler`**. The classic `"moduleResolution": "node"` (node10, the usual default for `"module": "commonjs"`) fails with `TS2307: Cannot find module '@factory/droid-sdk/node'` because the package has no `typesVersions` fallback. For CommonJS output in Electron main, use `"module": "node16", "moduleResolution": "node16"` (with no `"type": "module"`).
- With TS 5.6 and `skipLibCheck: false` you get `error TS2315: Type 'Uint8Array' is not generic` inside the SDK's `.d.ts`. Use **TS ≥ 5.7** or `skipLibCheck: true`.
- Use **Zod 3** (`npm install zod@^3.24.0`) so your `z` matches the SDK's `z.ZodTypeAny` tool shapes. The docs say this explicitly.

---

## 2. Runtime architecture and authentication

- **It spawns the `droid` CLI.** The SDK is a JSON-RPC client over stdio, and the `droid` CLI must be installed. From the source (`buildArgs`):
  ```
  <execPath ?? "droid"> exec --input-format stream-jsonrpc --output-format stream-jsonrpc [...execArgs]
  ```
  It uses `child_process.spawn(execPath, args, { cwd, env, stdio: ['pipe','pipe','pipe'] })` with no shell. So `"droid"` is resolved from the **inherited `PATH`**.
- **Child environment:** `{ ...process.env, ...options.env, FACTORY_API_KEY, FACTORY_UPSTREAM_CLIENT_TYPE: "sdk", FACTORY_UPSTREAM_SDK: <id> }`.
- **Authentication:** `apiKey` option, or else `process.env.FACTORY_API_KEY`. **If neither is set, `createSession`/`run` throw before spawning:**
  `DroidClientError: No Factory API key found. Pass `apiKey` when creating the session, or set the FACTORY_API_KEY environment variable.` (verified at runtime)
  Generate keys at `https://app.factory.ai/settings/api-keys`. Keys look like `fk-...`.
- **Missing droid binary** (verified at runtime): `ConnectionError: Failed to start Droid: executable not found (/nonexistent/droid)`.
- **Installing the CLI** (from Factory docs):
  - macOS/Linux: `curl -fsSL https://app.factory.ai/cli | sh`
  - Homebrew: `brew install --cask droid`
  - Windows: `irm https://app.factory.ai/cli/windows | iex`
  - npm: `npm install -g droid` (npm package `droid@0.249.0`, which requires Node ≥ 20)
- **Protocol compatibility:** the SDK sends `factoryProtocolVersion: "1.269.0"` (`FACTORY_PROTOCOL_VERSION`). SDK MCP servers are passed with `oauth: false`. That requires the droid peer protocol to be **≥ 1.78.0**, otherwise the call throws `ProtocolError("MCP OAuth opt-out requires Droid protocol version 1.78.0 or newer…")`. This is what the docs' "SDK and CLI must use compatible protocol versions" note refers to. Keep the CLI up to date.
- **This machine:** `which droid` → not found; `droid --version` → command not found. Node is v20.19.4 and npm is 10.8.2.

### Electron-specific notes
- **PATH:** an app launched from Finder or the Dock gets a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `spawn("droid")` will fail. Pass **`execPath: '/absolute/path/to/droid'`**, or resolve it at startup (for example from a login shell, or a setting the user configures). Where the curl installer puts the binary (commonly `~/.local/bin/droid`) is **not verified**.
- The SDK runs entirely in the main process (Node). Run it there and relay events to the renderer over IPC. Don't ship the API key to the renderer.
- Each `DroidSession` owns one `droid` child process. `session.close()` kills it, and the SDK MCP loopback servers are closed along with it. Call `close()` on `app.on('before-quit')`.
- The SDK has no native addons, so it is safe inside asar. The droid binary is external.

---

## 3. Top-level functions (verbatim from `dist/node.d.ts`)

```ts
declare function run(prompt: string, options?: RunOptions): Promise<DroidResult>;
declare function createSession(options?: CreateSessionOptions): Promise<DroidSession>;
declare function resumeSession(sessionId: string, options?: ResumeSessionOptions): Promise<DroidSession>;
declare function listSessions(options?: ListSessionsOptions): Promise<SessionMetadata[]>;
declare function listModels(options?: ListModelsOptions & TransportCreationOptions): Promise<ModelInfo[]>;
declare function createSdkMcpServer(options: SdkMcpServerOptions): SdkMcpServer;
declare function tool<InputShape extends ToolInputShape>(name: string, description: string, inputSchema: InputShape, handler: (input: z.infer<z.ZodObject<InputShape>>) => DroidToolResult | Promise<DroidToolResult>, options?: DroidToolOptions): DroidTool;
declare function tool(name: string, description: string, handler: DroidTool['handler'], options?: DroidToolOptions): DroidTool;
```

- `run()` creates a session, consumes the whole stream, returns the terminal `DroidResult`, and closes the session.
- `createSession()` and `resumeSession()`: you must call `await session.close()`, ideally in a `finally` block.
- `listSessions()` reads `~/.factory/sessions/*.jsonl` directly. It doesn't spawn droid or call the API.
- `listModels()` spawns a one-shot droid process.

## 4. Option types (verbatim)

```ts
interface TransportCreationOptions {
    /** Defaults to `process.env.FACTORY_API_KEY`. */
    apiKey?: string;
    execPath?: string;
    execArgs?: string[];
    cwd?: string;
    env?: Record<string, string>;
    observability?: DroidObservability;
    transport?: DroidClientTransport;
}
interface SessionInitOptions extends ToolSelectionOverrides {   // ToolSelectionOverrides = { disabledToolIds?: string[] }
    /** Defaults to `process.cwd()`. */
    cwd?: string;
    machineId?: string;
    modelId?: string;
    autonomyLevel?: AutonomyLevel;
    interactionMode?: DroidInteractionMode;
    reasoningEffort?: ReasoningEffort;
    systemPrompt?: SystemPromptConfig;
    specModeModelId?: string;
    specModeReasoningEffort?: ReasoningEffort;
    mcpServers?: DroidMcpServerConfig[];
    sessionSource?: SessionSource;
    tags?: SessionTag[];
    autoRejectPermissionRequests?: boolean;
    /** When true, Factory-provided builtin skills are unavailable. */
    disableBuiltinSkills?: boolean;
}
interface HandlerOptions {
    permissionHandler?: ClientPermissionHandler;
    askUserHandler?: ClientAskUserHandler;
}
interface CreateSessionOptions extends SessionInitOptions, HandlerOptions, TransportCreationOptions {
    abortSignal?: AbortSignal;          // session-level: aborting CLOSES the whole session
}
interface ResumeSessionOptions extends Pick<CreateSessionOptions, 'apiKey' | 'execPath' | 'execArgs' | 'env' | 'permissionHandler' | 'askUserHandler' | 'transport' | 'abortSignal' | 'observability' | 'disabledToolIds' | 'autoRejectPermissionRequests' | 'disableBuiltinSkills' | 'sessionSource'> {
    mcpServers?: DroidMcpServerConfig[];
}
interface RunOptions extends CreateSessionOptions, Omit<MessageOptions, 'includePartialMessages'> {}

interface MessageOptions {                 // per-turn options for session.stream() / run()
    images?: Base64ImageSource[];          // { type: 'base64', data, mediaType: 'image/jpeg'|'image/png'|'image/gif'|'image/webp' }
    files?: DocumentSource[];              // { type:'text', mediaType:'text/plain', data, name? } | { type:'base64', mediaType:'application/pdf', data, name? }
    outputFormat?: OutputFormat;           // { type: 'json_schema'; schema: Record<string, unknown> }
    includePartialMessages?: boolean;
    abortSignal?: AbortSignal;             // turn-level: interrupts the turn and makes the stream THROW
}

type SystemPromptConfig = string | { type: 'preset'; preset: 'droid'; append: string };
// string replaces Droid's default prompt; preset form appends to it.

interface ListSessionsOptions { cwd?: string; fetchOutsideCWD?: boolean; limit?: number; sessionsDir?: string; }
// SessionMetadata: { id; title; owner; messageCount; modifiedTime: Date; createdTime: Date; isFavorite?; cwd?; ... }
// ListModelsOptions: { includeDisabled?: boolean }
```

- `autoRejectPermissionRequests` (doc comment in the source): "When true, permission requests in this session are auto-rejected instead of being forwarded to a user/approver… Defaults to false (forwarded)."
- `resumeSession()` does not accept `cwd`, `modelId`, or reasoning options. The persisted values are used. You **must re-attach** the handlers, SDK MCP servers, observability, and abort signal on resume.

**External MCP server configs** (`McpServerConfig`), which go in `mcpServers` next to `SdkMcpServer` instances:
```ts
{ name: string; command: string; args?: string[]; env?: Record<string,string> }          // stdio (no `type`)
{ type: 'http'; name: string; url: string; headers: { name: string; value: string }[]; oauth?: false | {...} }
{ type: 'sse';  name: string; url: string; headers: { name: string; value: string }[] }
```

## 5. `DroidSession` (verbatim)

```ts
declare class DroidSession {
    get id(): string;
    get settings(): Readonly<SessionSettings>;   // .modelId, .reasoningEffort, .interactionMode, ...
    get cwd(): string | undefined;
    /** Yields message-level events until the final `result` message. */
    stream(prompt: string, options?: MessageOptions & { includePartialMessages?: false; }): AsyncGenerator<DroidStreamMessage, void, undefined>;
    /** Yields message-level events plus partial chunks until the final `result` message. */
    stream(prompt: string, options: MessageOptions & { includePartialMessages: true; }): AsyncGenerator<DroidStreamEvent, void, undefined>;
    interrupt(): Promise<void>;
    close(): Promise<void>;
    updateSettings(params: DroidSessionUpdateSettingsOptions): Promise<UpdateSessionSettingsResult>;
    enterSpecMode(params?: Pick<UpdateSessionSettingsRequestParams, 'specModeModelId' | 'specModeReasoningEffort'>): Promise<UpdateSessionSettingsResult>;
    exitSpecMode(): Promise<UpdateSessionSettingsResult>;
    addMcpServer(params: AddMcpServerRequestParams): Promise<AddMcpServerResult>;
    removeMcpServer(params: RemoveMcpServerRequestParams): Promise<RemoveMcpServerResult>;
    toggleMcpServer(params: ToggleMcpServerRequestParams): Promise<ToggleMcpServerResult>;
    listMcpServers(): Promise<ListMcpServersResult>;
    listMcpTools(): Promise<McpToolInfo[]>;
    refreshConnectorToolCatalog(): Promise<void>;
    listTools(params: ListToolsOptions & { includeSchemas: true; }): Promise<ToolInfoWithSchemas[]>;
    listTools(params?: ListToolsOptions): Promise<ToolInfo[]>;          // ToolInfo has .id, .allowed, .source?, .schemas?
    authenticateMcpServer(params: AuthenticateMcpServerRequestParams): Promise<AuthenticateMcpServerResult>;
    listSkills(params?: ListSkillsRequestParams): Promise<ListSkillsResult>;
    setSkillDisabled(params: SetSkillDisabledRequestParams): Promise<SetSkillDisabledResult>;
    getRewindInfo(params: Omit<GetRewindInfoRequestParams, 'sessionId'>): Promise<GetRewindInfoResult>;
    rewind(params: Omit<ExecuteRewindRequestParams, 'sessionId'>): Promise<SessionRewindOutcome<DroidSession>>;
    compact(params?: Omit<CompactSessionRequestParams, 'mode'>): Promise<SessionCompactionOutcome<DroidSession>>;
    handoff(params?: Omit<CompactSessionRequestParams, 'mode'>): Promise<SessionCompactionOutcome<DroidSession>>;
    fork(params?: ForkSessionRequestParams): Promise<DroidSession>;
    getContextStats(): Promise<GetContextStatsResult>;   // { used, remaining, limit, accuracy }
    rename(params: RenameSessionRequestParams): Promise<void>;   // { title: string }
    onNotification(callback: NotificationCallback, filter?: NotificationFilter): () => void;
}
```

- `updateSettings` accepts these fields (from the schema): `modelId?`, `reasoningEffort?`, `interactionMode?`, `autonomyLevel?`, `specModeModelId?`, `specModeReasoningEffort?`, `missionSettings?`, `tags?`, `compactionTokenLimit?`, `compactionThresholdCheckEnabled?`, `disabledToolIds?`.
- `fork()`, `compact()`, and `rewind()` return a **successor** session. After that, active calls on the old wrapper throw `SessionReplacedError`. Don't replace a session while a stream is active (that throws `ConcurrentStreamError`).
- `exitSpecMode()` and `handoff()` exist in the `.d.ts` but are not in the docs.

### Persistent session pattern
A session holds the conversation, and **every `session.stream(prompt)` call is one turn** in the same conversation. Call `stream()` again after the previous generator finishes to send the next prompt. **Only one active stream per session.** A second concurrent `stream()` throws `ConcurrentStreamError`. There is no input queue, so serialize prompts yourself (for example with a promise chain or mutex in the main process).

---

## 6. Streaming: message and event types (verbatim)

`session.stream()` yields `DroidStreamMessage` by default. With `includePartialMessages: true` it yields `DroidStreamEvent`, which is the complete messages plus the partials. In partial mode **both** the deltas and the complete `assistant` message are emitted, so don't print both.

```ts
declare const DroidMessageType: {
    readonly Assistant: "assistant";
    readonly User: "user";
    readonly ToolCall: "tool_call";
    readonly AssistantTextDelta: "assistant_text_delta";
    readonly AssistantTextComplete: "assistant_text_complete";
    readonly AssistantMessageRetracted: "assistant_message_retracted";
    readonly ThinkingTextDelta: "thinking_text_delta";
    readonly ThinkingTextComplete: "thinking_text_complete";
    readonly ToolCallDelta: "tool_call_delta";
    readonly ToolResult: "tool_result";
    readonly ToolProgress: "tool_progress";
    readonly WorkingStateChanged: "working_state_changed";
    readonly TokenUsageUpdate: "token_usage_update";
    readonly PermissionResolved: "permission_resolved";
    readonly SettingsUpdated: "settings_updated";
    readonly SessionTitleUpdated: "session_title_updated";
    readonly SessionWorkingDirectoryChanged: "session_working_directory_changed";
    readonly McpStatusChanged: "mcp_status_changed";
    readonly MissionStateChanged: "mission_state_changed";
    readonly MissionFeaturesChanged: "mission_features_changed";
    readonly MissionProgressEntry: "mission_progress_entry";
    readonly MissionHeartbeat: "mission_heartbeat";
    readonly MissionWorkerStarted: "mission_worker_started";
    readonly MissionWorkerCompleted: "mission_worker_completed";
    readonly McpAuthRequired: "mcp_auth_required";
    readonly McpAuthCompleted: "mcp_auth_completed";
    readonly Hook: "hook";
    readonly Error: "error";
    readonly Result: "result";
};

type DroidStreamMessage = DroidAssistantMessage | DroidUserMessage | DroidToolCallMessage | ToolResult | HookExecution | ErrorEvent | DroidResultMessage;
type DroidStreamEvent = DroidStreamMessage | AssistantTextDelta | AssistantTextComplete | AssistantMessageRetracted | ThinkingTextDelta | ThinkingTextComplete | ToolCallDelta | ToolProgress | WorkingStateChanged | TokenUsageUpdate | PermissionResolved | SettingsUpdated | SessionTitleUpdated | SessionWorkingDirectoryChanged | McpStatusChanged | MissionStateChanged | MissionFeaturesChanged | MissionProgressEntry | MissionHeartbeat | MissionWorkerStarted | MissionWorkerCompleted | McpAuthRequired | McpAuthCompleted | HookExecution;

interface DroidAssistantMessage { readonly type: 'assistant'; readonly message: FactoryDroidMessage; readonly text: string; }
interface DroidUserMessage      { readonly type: 'user'; readonly message: FactoryDroidMessage; }
interface DroidToolCallMessage  { readonly type: 'tool_call'; readonly name: string; readonly toolUseId: string; readonly input: ToolUseBlock['input']; }
interface ToolResult            { readonly type: 'tool_result'; readonly toolUseId: string; readonly toolName: string; readonly content: string | JsonValue[]; readonly isError: boolean; }
interface AssistantTextDelta    { readonly type: 'assistant_text_delta'; readonly messageId: string; readonly blockIndex: number; readonly text: string; }
interface ThinkingTextDelta     { readonly type: 'thinking_text_delta'; readonly messageId: string; readonly blockIndex: number; readonly text: string; }
interface ToolCallDelta         { readonly type: 'tool_call_delta'; readonly toolUse: ToolUseBlock; }
interface ToolProgress          { readonly type: 'tool_progress'; readonly toolUseId: string; readonly toolName: string; readonly content: string; readonly update: ToolProgressUpdate; }
interface WorkingStateChanged   { readonly type: 'working_state_changed'; readonly state: DroidWorkingState; }
// DroidWorkingState: 'idle' | 'thinking' | 'streaming_assistant_message' | 'waiting_for_tool_confirmation' | 'executing_tool' | 'compacting_conversation'
type TokenUsageUpdate = Readonly<{ type: 'token_usage_update'; } & TokenUsage>;   // cumulative for the session
interface PermissionResolved    { readonly type: 'permission_resolved'; readonly requestId: string; readonly toolUseIds: string[]; readonly selectedOption: ToolConfirmationOutcome; }
interface HookExecution         { readonly type: 'hook'; readonly hookId: string; readonly eventName?: string; readonly matcher?: string; readonly toolCallId?: string; readonly command?: string; readonly timeout?: number; readonly status: 'started' | 'completed' | 'error'; readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string; readonly suppressOutput?: boolean; }
interface ErrorEvent            { readonly type: 'error'; readonly message: string; readonly errorType: ErrorNotification['errorType']; readonly timestamp: string; }
// errorType: 'ConnectionError'|'ProtocolError'|'SessionError'|'TimeoutError'|'DroidClientError'|'ProcessExitError'|'Error'

interface DroidResultBase {
    readonly type: 'result';
    readonly sessionId: string;
    readonly durationMs: number;
    readonly tokenUsage: TokenUsage | null;
    /** Stream messages emitted before this result. */
    readonly messages: DroidStreamEvent[];
    readonly text: string;
    readonly turnCount: number;
    readonly success: boolean;
}
interface DroidResultSuccessMessage extends DroidResultBase { readonly subtype: 'success'; readonly success: true; readonly interrupted: false; readonly structuredOutput?: unknown; readonly structuredOutputError?: null; readonly error: null; }
interface DroidResultInterruptedMessage extends DroidResultBase { readonly subtype: 'interrupted'; readonly success: false; readonly interrupted: true; readonly structuredOutput?: unknown; readonly structuredOutputError?: null; readonly error: null; }
interface DroidResultErrorMessage extends DroidResultBase { readonly subtype: 'error_during_execution' | 'error_structured_output'; readonly success: false; readonly interrupted: false; readonly structuredOutput?: unknown; readonly structuredOutputError?: StructuredOutputError | null; readonly error: ErrorEvent | null; }
type DroidResultMessage = DroidResultSuccessMessage | DroidResultInterruptedMessage | DroidResultErrorMessage;
type DroidResult = DroidResultMessage;

// TokenUsage: { inputTokens; outputTokens; cacheCreationTokens; cacheReadTokens; thinkingTokens; factoryCredits?: number }  (per turn on the result)
```

**Errors versus failed results** (docs): an `error` stream message reports a runtime problem, and a terminal result normally follows it. A failed `DroidResult` means the stream finished but the work failed. A **thrown** exception means the SDK operation itself failed: abort, connection, protocol, or a concurrent stream. `run()` follows the same split.

---

## 7. In-process custom tools (verbatim types and verified behavior)

```ts
type ToolInputShape = Record<string, z.ZodTypeAny>;           // a Zod RAW SHAPE, e.g. { path: z.string() }, NOT z.object(...)
type DroidToolResult = string | CallToolResult;                // CallToolResult from @modelcontextprotocol/sdk/types.js
interface DroidToolOptions {
    /**
     * MCP tool annotations. Droid treats a tool with `readOnlyHint: true` as
     * low impact, so it runs without a permission prompt at Low autonomy or
     * above. Tools without it are treated as high impact.
     */
    annotations?: ToolAnnotations;                             // { title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }
}
interface DroidTool extends DroidToolOptions {
    name: string;
    description?: string;
    inputSchema?: ToolInputShape;
    handler: (input: Record<string, unknown>) => DroidToolResult | Promise<DroidToolResult>;
}
interface SdkMcpServerOptions { name: string; version?: string; tools: DroidTool[]; }
type DroidMcpServerConfig = McpServerConfig | SdkMcpServer;
declare class SdkMcpServer {
    readonly name: string;
    readonly version: string;
    readonly tools: DroidTool[];
    constructor(options: SdkMcpServerOptions);
    get config(): HttpMcpConfig | null;
    start(): Promise<HttpMcpConfig>;
    close(): Promise<void>;
}
```

**Schema format: Zod 3 raw shape.** JSON Schema is not used for tool inputs. (JSON Schema appears only for `outputFormat` structured output.) The handler receives input already run through `z.object(shape).parse(input)` and fully typed.

**Return values:**
- `string` becomes `{ content: [{ type: 'text', text }] }`.
- Otherwise return an MCP `CallToolResult`, for example `{ content: [{ type: 'text', text: '...' }], isError: true }`. Image and other MCP content blocks are allowed.
- A handler that throws (including on Zod parse errors) is handled by the MCP SDK's `McpServer.registerTool`. From what I know of MCP SDK behavior it returns an `isError` tool result to the model. **I did not test this.**

**Mechanics** (from the source, plus a runtime check of `start()`):
- The SDK starts an HTTP server on `127.0.0.1:<random port>/mcp` using MCP Streamable HTTP. Each request needs a random 32-byte bearer token.
- Droid receives `{"type":"http","name":"<server name>","url":"http://127.0.0.1:<port>/mcp","oauth":false,"headers":[{"name":"Authorization","value":"Bearer …"}]}`.
- The server starts when the session is created and stops on `session.close()`.
- **Tool calls go through the session's autonomy and permission rules**, and they arrive in `permissionHandler` with `details.type === ToolConfirmationType.McpTool`.
- **Re-attach** SDK MCP servers on `resumeSession()`.

---

## 8. Permissions and AskUser (verbatim)

```ts
declare enum AutonomyLevel { Off = "off", Low = "low", Medium = "medium", High = "high" }
// Off: ask before every action | Low: file edits + read-only commands allowed | Medium: reversible commands | High: everything without prompts
declare enum DroidInteractionMode { Auto = "auto", Spec = "spec", /** @deprecated */ AGI = "agi", Mission = "mission" }

type ClientPermissionHandler = (params: RequestPermissionRequestParams) => RequestPermissionHandlerResult | Promise<RequestPermissionHandlerResult>;
type ClientAskUserHandler   = (params: AskUserRequestParams) => AskUserResult | Promise<AskUserResult>;

// RequestPermissionRequestParams (z.infer of RequestPermissionRequestParamsSchema), shape:
{
  toolUses: ToolConfirmationInfo[];
  options: { label: string; value: ToolConfirmationOutcome }[];   // the ONLY outcomes you may return
  associatedSessionIds?: string[];
}
// ToolConfirmationInfo:
{
  toolUse: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; namespace?: string; thoughtSignature?: string; scriptExecution?: { runId: string; outerToolUseId: string } };
  confirmationType: ToolConfirmationType;
  details: ToolConfirmationDetails;   // discriminated union on `type`, see below
}

type RequestPermissionSelection = ToolConfirmationOutcome | `${ToolConfirmationOutcome}`;
type RequestPermissionHandlerResult = RequestPermissionNonEditSelection | {
    selectedOption: RequestPermissionNonEditSelection;
    comment?: string;
} | {
    selectedOption: ProceedEditSelection;
    comment?: string;
    editedSpecContent: string;
};

declare enum ToolConfirmationOutcome {
    ProceedOnce = "proceed_once",
    ProceedAlways = "proceed_always",
    ProceedAlwaysForExactPath = "proceed_always_file",
    ProceedAutoRun = "proceed_auto_run",
    ProceedAutoRunLow = "proceed_auto_run_low",
    ProceedAutoRunMedium = "proceed_auto_run_medium",
    ProceedAutoRunHigh = "proceed_auto_run_high",
    ProceedNewSession = "proceed_new_session",
    ProceedNewSessionLow = "proceed_new_session_low",
    ProceedNewSessionMedium = "proceed_new_session_medium",
    ProceedNewSessionHigh = "proceed_new_session_high",
    ProceedEdit = "proceed_edit",
    ProceedAlwaysTools = "proceed_always_tools",     // MCP: persist approval for specific tool(s)
    ProceedAlwaysServer = "proceed_always_server",   // MCP: persist approval for all tools of a server
    ProceedReportFalsePositive = "proceed_report_false_positive",
    Cancel = "cancel"
}
declare enum ToolConfirmationType {
    Edit = "edit", Execute = "exec", Create = "create", AskUser = "ask_user", ExitSpecMode = "exit_spec_mode",
    RecommendMission = "recommend_mission", ProposeMission = "propose_mission", StartMissionRun = "start_mission_run",
    ApplyPatch = "apply_patch", McpTool = "mcp_tool", SandboxViolation = "sandbox_violation",
    DroidShieldViolation = "droid_shield_violation", Script = "script"
}

// Selected `details` variants (output types):
{ type: ToolConfirmationType.Edit;    filePath: string; fileName: string; oldContent?: string; newContent?: string }
{ type: ToolConfirmationType.Execute; command: string; fullCommand: string; extractedCommands?: string[]; impactLevel?: string; riskLevelReason?: string }
{ type: ToolConfirmationType.Create;  content: string; filePath: string; fileName: string }
{ type: ToolConfirmationType.McpTool; toolName: string; impactLevel: string; serverName?: string; actualToolName?: string }
{ type: ToolConfirmationType.ExitSpecMode; plan: string; title?: string; contextSavingsPercent?: number; supportsClientStartedHandoff?: boolean }
{ type: ToolConfirmationType.ApplyPatch; filePath; fileName; patchContent; oldContent?; newContent?; files?: {...}[] }

// AskUser
AskUserRequestParams = { toolCallId: string; questions: { index: number; topic: string; question: string; options: string[]; multiSelect?: boolean; workstreamProposal?: … }[] }
AskUserResult        = { cancelled?: boolean; answers: { index: number; question: string; answer: string }[] }
```

**Permission handler rules** (verified in `DroidClient.handlePermissionRequest`):
- The handler may be sync or async. The SDK awaits it, so you can wait on a UI dialog. I found no client-side timeout. **Whether the CLI times out a pending request is unverified.**
- You can return a bare outcome string or enum, or `{ selectedOption, comment? }`.
- The **outcome must be one of `params.options[].value`**. Otherwise the SDK sends `cancel`.
- **Throwing, returning an invalid value, or having no handler means `cancel`.** Returning `ProceedEdit` without `editedSpecContent` also means cancel.
- A declined permission typically ends the turn with `subtype: 'interrupted'` (docs).
- No AskUser handler means AskUser requests are declined. To decline from a handler, return `{ cancelled: true, answers: [] }`.
- The public SDK only offers subtractive `disabledToolIds`. There is **no allowlist**.

---

## 9. Interrupt, abort, cancel (verified in `streamFromClient`)

| Mechanism | Effect |
| --- | --- |
| `await session.interrupt()` from anywhere, such as an IPC "Stop" button | Sends `interruptSession` to droid. The stream **continues to a terminal result with `subtype: 'interrupted'`** (`interrupted: true`). The session stays usable. |
| `session.stream(prompt, { abortSignal })` with `controller.abort(reason)` | Interrupts the turn, and the **stream throws the abort reason**. The session stays usable. You don't receive the result. |
| `break` or `return` out of the `for await` loop before the result | The SDK sends an interrupt in the generator's `finally`. The session stays open, and that loop doesn't get the result. |
| `createSession({ abortSignal })` | Aborting **closes the entire session**. |
| `session.close()` | Ends the session, kills the subprocess, and closes the SDK MCP servers. |

---

## 10. Models and settings

```ts
declare enum ReasoningEffort { None = "none", Dynamic = "dynamic", Off = "off", Minimal = "minimal", Low = "low", Medium = "medium", High = "high", ExtraHigh = "xhigh", Max = "max" }
declare const OutputFormatType: { readonly JsonSchema: "json_schema" };
```

- `modelId` is a string. Omit it for the default. `"auto"` uses the Factory Router. Custom BYOK models from `~/.factory/settings.json` are `"custom:<model>"`.
- Get the catalog with `listModels({ includeDisabled? })`. It returns `ModelInfo[]` with `id`, `displayName`, `shortDisplayName`, `modelProvider`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `isCustom`, `disabled`/`disabledReason`, `noImageSupport?`, and `supportsImageGeneration?`.
- `session.updateSettings({ modelId, reasoningEffort, autonomyLevel, interactionMode, disabledToolIds, ... })` changes settings for later turns.

## 11. Errors (exported classes, verified at runtime)

`DroidClientError` (base), `ConnectionError`, `TimeoutError`, `ProtocolError`, `ProcessExitError`, `SessionError` (base), `SessionNotFoundError`, `InvalidSessionCwdError`, `ConcurrentStreamError`, `SessionReplacedError`, `SessionReplacementError`, `AbortError`.

## 12. Observability (optional)

```ts
interface DroidObservability { logger?: DroidLogger; metrics?: DroidMetricSink; tracing?: DroidTraceContextProvider; }
interface DroidLogger { log(event: DroidLogEvent): void; }
interface DroidLogEvent { level: 'debug' | 'info' | 'warn' | 'error'; name: string; message: string; attributes?: DroidAttributes; error?: DroidSerializedError; }
```

Sinks must not throw. Prompts and tool inputs are excluded from events. For raw protocol notifications, use `session.onNotification(cb, { type? })`, which returns an unsubscribe function.

---

## 13. Complete example (compile-verified against 0.10.0)

This example:
- creates a persistent session with two in-process tools,
- streams and prints every step and tool call,
- auto-approves read-only tools and asks a user-supplied async function for everything else,
- sends a second prompt to the same session,
- interrupts a running turn (with `interrupt()`, and also shows the `AbortController` option),
- reuses the session afterwards.

Install: `npm i @factory/droid-sdk@0.10.0 zod@^3.24.0`. tsconfig: `"module": "node16", "moduleResolution": "node16"` (CJS) or `bundler`, with TS ≥ 5.7 or `skipLibCheck: true`.

```ts
// droid-agent.ts — Electron main-process module (works as CJS or ESM output).
// Verified against @factory/droid-sdk@0.10.0 type definitions (tsc --noEmit, strict).
import { z } from 'zod';
import {
  createSession,
  createSdkMcpServer,
  tool,
  AutonomyLevel,
  DroidMessageType,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  ConcurrentStreamError,
  type DroidSession,
  type DroidResult,
  type DroidToolResult,
  type ToolConfirmationInfo,
  type RequestPermissionRequestParams,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk/node';

/** Your UI-backed approval function (e.g. an Electron dialog / IPC round-trip). */
export type AskApproval = (req: {
  toolUses: ToolConfirmationInfo[];
  options: RequestPermissionRequestParams['options'];
}) => Promise<boolean>;

// ---------------------------------------------------------------------------
// 1. Two in-process custom tools (served by an SDK-owned loopback MCP server)
// ---------------------------------------------------------------------------
const notes = new Map<string, string>();

const READ_ONLY_TOOL_NAMES = new Set(['read_note']);

const notesServer = createSdkMcpServer({
  name: 'notes',
  tools: [
    tool(
      'read_note',
      'Read a saved note by title. Returns the note text or an error.',
      { title: z.string().describe('Note title') },
      ({ title }): DroidToolResult => {
        const text = notes.get(title);
        if (text === undefined) {
          // CallToolResult form: flag the failure to the model.
          return { content: [{ type: 'text', text: `No note named "${title}".` }], isError: true };
        }
        return text; // plain string form -> { content: [{ type: 'text', text }] }
      },
      // readOnlyHint: Droid treats this as low impact (no prompt at Low autonomy or above).
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      'save_note',
      'Save (create or overwrite) a note.',
      { title: z.string(), text: z.string() },
      async ({ title, text }) => {
        notes.set(title, text);
        return `Saved note "${title}" (${text.length} chars).`;
      },
      { annotations: { readOnlyHint: false, destructiveHint: true } }
    ),
  ],
});

// ---------------------------------------------------------------------------
// 2. Permission callback: auto-approve our read-only tools, ask the user otherwise
// ---------------------------------------------------------------------------
function isReadOnlySdkTool(info: ToolConfirmationInfo): boolean {
  if (info.details.type !== ToolConfirmationType.McpTool) return false;
  // NOTE (unverified): the exact name Droid reports for SDK MCP tools (prefixed vs.
  // raw) is not documented. Check all three fields and match the raw name suffix.
  const names = [info.details.actualToolName, info.details.toolName, info.toolUse.name].filter(
    (n): n is string => typeof n === 'string'
  );
  return names.some((n) => [...READ_ONLY_TOOL_NAMES].some((t) => n === t || n.endsWith(t)));
}

function makePermissionHandler(askUser: AskApproval) {
  return async ({ toolUses, options }: RequestPermissionRequestParams): Promise<RequestPermissionHandlerResult> => {
    const offered = (o: ToolConfirmationOutcome) => options.some((opt) => opt.value === o);

    for (const t of toolUses) {
      console.log(`[permission] ${t.confirmationType} ${t.toolUse.name} ${JSON.stringify(t.toolUse.input)}`);
    }

    const approve =
      (toolUses.length > 0 && toolUses.every(isReadOnlySdkTool)) || (await askUser({ toolUses, options }));

    // Must return one of the offered values; anything else (or a throw) = Cancel.
    if (approve && offered(ToolConfirmationOutcome.ProceedOnce)) return ToolConfirmationOutcome.ProceedOnce;
    return ToolConfirmationOutcome.Cancel;
  };
}

// ---------------------------------------------------------------------------
// 3. Stream one turn, printing every step; returns the terminal DroidResult
// ---------------------------------------------------------------------------
async function runTurn(session: DroidSession, prompt: string, abortSignal?: AbortSignal): Promise<DroidResult | undefined> {
  let result: DroidResult | undefined;
  console.log(`\n>>> ${prompt}`);

  for await (const ev of session.stream(prompt, { includePartialMessages: true, abortSignal })) {
    switch (ev.type) {
      case DroidMessageType.AssistantTextDelta:
        process.stdout.write(ev.text);
        break;
      case DroidMessageType.Assistant: // complete message (text already streamed as deltas)
        process.stdout.write('\n');
        break;
      case DroidMessageType.ThinkingTextDelta:
        break; // ev.text holds reasoning text if you want it
      case DroidMessageType.ToolCall:
        console.log(`[tool_call] ${ev.name} id=${ev.toolUseId} input=${JSON.stringify(ev.input)}`);
        break;
      case DroidMessageType.ToolProgress:
        console.log(`[tool_progress] ${ev.toolName}: ${ev.content}`);
        break;
      case DroidMessageType.ToolResult: {
        const body = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content);
        console.log(`[tool_result] ${ev.toolName} isError=${ev.isError} ${body.slice(0, 200)}`);
        break;
      }
      case DroidMessageType.WorkingStateChanged:
        console.log(`[state] ${ev.state}`);
        break;
      case DroidMessageType.PermissionResolved:
        console.log(`[permission_resolved] ${ev.selectedOption} for ${ev.toolUseIds.join(',')}`);
        break;
      case DroidMessageType.TokenUsageUpdate:
        break; // cumulative session usage: ev.inputTokens, ev.outputTokens, ...
      case DroidMessageType.Hook:
        console.log(`[hook] ${ev.status} ${ev.command ?? ''}`);
        break;
      case DroidMessageType.Error:
        console.error(`[error:${ev.errorType}] ${ev.message}`);
        break;
      case DroidMessageType.Result:
        result = ev;
        console.log(`[result] ${ev.subtype} turns=${ev.turnCount} ${ev.durationMs}ms tokens=${JSON.stringify(ev.tokenUsage)}`);
        break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 4. Persistent session: two prompts, then an interrupted turn, then reuse
// ---------------------------------------------------------------------------
export async function demo(askUser: AskApproval, opts: { cwd: string; droidPath?: string }): Promise<void> {
  const session = await createSession({
    cwd: opts.cwd,
    execPath: opts.droidPath, // absolute path recommended in packaged Electron apps (minimal PATH)
    // apiKey: '...',          // defaults to process.env.FACTORY_API_KEY (throws if neither is set)
    autonomyLevel: AutonomyLevel.Off, // Off = every action goes through permissionHandler
    mcpServers: [notesServer],
    permissionHandler: makePermissionHandler(askUser),
    askUserHandler: async ({ questions }) => ({
      // Wire to your UI; must echo index + question. Or return { cancelled: true, answers: [] }.
      answers: questions.map((q) => ({ index: q.index, question: q.question, answer: q.options[0] ?? '' })),
    }),
  });

  try {
    console.log('session id:', session.id);

    // Turn 1
    const r1 = await runTurn(session, 'Save a note titled "groceries" with text "eggs, milk", then read it back with read_note.');
    if (r1 && !r1.success) console.warn('turn 1 failed:', r1.subtype, r1.error?.message);

    // Turn 2 — same session, same conversation context
    await runTurn(session, 'What did the note you saved earlier say? Use read_note to confirm.');

    // Turn 3 — interrupt while running (server-side interrupt; session stays usable)
    const timer = setTimeout(() => {
      session.interrupt().catch((e: unknown) => console.error('interrupt failed', e));
    }, 3000);
    try {
      const r3 = await runTurn(session, 'Write a 3000-word essay about the history of note taking.');
      console.log('turn 3 subtype:', r3?.subtype, 'interrupted:', r3?.interrupted); // expect 'interrupted', true
    } finally {
      clearTimeout(timer);
    }

    // Alternative: AbortController — the stream THROWS the abort reason (and also interrupts the turn).
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user cancelled')), 2000);
    try {
      await runTurn(session, 'Write another very long essay.', ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) throw e;
      console.log('aborted:', (e as Error).message);
    }

    // Turn 5 — session still usable after interrupt/abort
    await runTurn(session, 'Reply with just: still here');
  } catch (e) {
    if (e instanceof ConcurrentStreamError) console.error('only one active stream per session');
    throw e;
  } finally {
    await session.close(); // kills droid subprocess + closes the SDK MCP server
  }
}

// Example wiring (Electron main):
//   import { dialog } from 'electron';
//   const askUser: AskApproval = async ({ toolUses }) =>
//     (await dialog.showMessageBox({
//       message: `Allow ${toolUses.map((t) => t.toolUse.name).join(', ')}?`,
//       buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1,
//     })).response === 0;
//   await demo(askUser, { cwd: app.getPath('documents'), droidPath: '/Users/you/.local/bin/droid' });
```

**Verification status of this example:** it type-checks under strict TS (node16 CJS, bundler, TS 5.6 with skipLibCheck, and TS 5.7.3 without skipLibCheck). The compiled CJS module loads in Node 20. **It has not been run against a live droid**, because neither the CLI nor an API key is available here.

---

## 14. Things I could NOT verify

1. **How SDK MCP tools are named at runtime**: the exact string in `DroidToolCallMessage.name`, `ToolConfirmationInfo.toolUse.name`, and `details.toolName` / `details.actualToolName` (for example raw `read_note` versus a server-prefixed form). The example matches by suffix across all three fields to be safe. Log one real permission request and then tighten the match.
2. **Whether `AutonomyLevel.Off` sends a permission request for SDK tools marked `readOnlyHint: true`.** The docs only say they run without a prompt "at Low autonomy or above". It's also unknown which native read-only tools (Read, Grep, LS…) prompt at `Off`, and what the `impactLevel` string values are.
3. **Whether the droid CLI times out** a permission or AskUser request that is still waiting on your async UI. The SDK client itself waits indefinitely.
4. **Tool handlers that throw:** my understanding is that the MCP SDK `McpServer` turns a throw into an `isError` tool result, but I didn't test it.
5. **Where installers put the CLI binary** (for example `~/.local/bin/droid`, or a Homebrew cask path). Check with `which droid` after installing.
6. **The minimum droid CLI version** that supports `--input-format stream-jsonrpc` and SDK MCP tools. From source, peer protocol ≥ 1.78.0 is needed for `oauth: false`, but I don't know how that maps to CLI versions. Install the latest CLI (npm `droid` is at 0.249.0).
7. **Event timing:** whether `session.interrupt()` always yields an `interrupted` result, or whether a turn that is about to finish yields `success` instead. The packaged `interrupt-session.ts` example handles both cases.
8. **`exitSpecMode()` and `handoff()`** appear in the `.d.ts` but not in the docs, and I didn't exercise them.

## 15. Sources

- https://docs.factory.com/sdk/typescript (raw: https://docs.factory.com/sdk/typescript.md)
- https://docs.factory.com/llms.txt
- https://docs.factory.com/droid-exec/overview.md
- https://docs.factory.com/droid-cli/quickstart.md
- npm: `@factory/droid-sdk@0.10.0` tarball: `dist/node.d.ts`, `dist/index-DWBA4zgW.d.ts`, `dist/node.mjs`, `dist/chunk-TWAVPIPS.mjs`, `examples/node/*.ts`, `README.md`
- Examples on GitHub: https://github.com/Factory-AI/droid-sdk-typescript/tree/main/examples/node
