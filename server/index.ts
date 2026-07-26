import { resolveCursorModel } from "../worker/cursor";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bearerToken,
  errorResponse,
  HttpError,
  json,
  notFound,
  openAiError,
  optionsResponse,
  parseJsonBody,
  sseResponse,
  unauthorized
} from "../worker/http";
import {
  assertModelAllowed,
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  modelList,
  parseModelAllowlist,
  prepareChatRequest,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseInputItemsObject,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
  toOpenAiToolCalls
} from "../worker/openai";
import { encodeSse } from "../worker/sse";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Default 8788 so bare-metal Linux doesn't collide with hermes-webui (:8787).
const PORT = parseInt(process.env.PORT || "8788", 10);
const HOST = process.env.HOST || process.env.CURSOR_API_HOST || "127.0.0.1";
const BRIDGE_URL = process.env.CURSOR_SDK_BRIDGE_URL || "http://127.0.0.1:8792/sdk";
const BRIDGE_TOKEN = process.env.CURSOR_SDK_BRIDGE_TOKEN || "";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTEXT_WINDOW_CACHE_FILE = path.resolve(
  process.env.CURSOR_SDK_CONTEXT_WINDOWS_FILE || path.join(REPO_ROOT, ".cursor-sdk-context-windows.json")
);
const ALLOWED_MODEL_IDS = parseModelAllowlist(process.env.COMPOSER_API_MODELS);
/** Default agent cwd when the request does not imply one. */
const DEFAULT_WORKING_DIRECTORY = resolveDefaultWorkingDirectory();
/**
 * Optional Cursor key stored on the server. When set with LOCAL_API_KEY,
 * clients (e.g. Hermes) send LOCAL_API_KEY and never need the Cursor secret.
 */
const CURSOR_API_KEY = (process.env.CURSOR_API_KEY || "").trim();
/**
 * Optional gateway key for local clients. When set, Bearer must match this
 * (or the Cursor key, for backward compatibility). When unset, Bearer is the
 * Cursor API key (direct mode).
 */
const LOCAL_API_KEY = (process.env.LOCAL_API_KEY || process.env.API_GATEWAY_KEY || "").trim();

const RESPONSE_STATE_LIMIT = 512;

function resolveDefaultWorkingDirectory(): string {
  const configured =
    process.env.CURSOR_SDK_WORKING_DIRECTORY?.trim() ||
    process.env.WORKING_DIRECTORY?.trim() ||
    process.env.CURSOR_SDK_PROXY_CWD?.trim();
  if (configured) return configured;
  return process.cwd();
}

function cachedContextWindows(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(CONTEXT_WINDOW_CACHE_FILE, "utf8")) as {
      contextWindows?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(parsed.contextWindows ?? {})
        .filter((entry): entry is [string, number] => (
          typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] > 0
        ))
        .map(([model, contextWindow]) => [model.trim().toLowerCase(), contextWindow])
    );
  } catch {
    return {};
  }
}

function localModelList(options: { opencode?: boolean; sdk?: boolean } = {}): Record<string, unknown> {
  return modelList({
    ...options,
    contextWindows: cachedContextWindows(),
    allowedModelIds: ALLOWED_MODEL_IDS
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface ResolvedAuth {
  /** Key forwarded to the SDK bridge / Cursor. */
  cursorApiKey: string;
  /** Stable owner id for response state. */
  ownerKey: string;
}

function resolveAuth(request: Request): ResolvedAuth | null {
  const token = bearerToken(request);
  if (!token) {
    // Allow unauthenticated only when both keys are configured via env and
    // LOCAL_API_KEY is empty? No — always require a bearer for API routes.
    return null;
  }

  if (LOCAL_API_KEY) {
    if (token === LOCAL_API_KEY) {
      if (!CURSOR_API_KEY) {
        throw new HttpError(
          "LOCAL_API_KEY is set but CURSOR_API_KEY is missing on the server",
          500,
          "server_misconfigured"
        );
      }
      return { cursorApiKey: CURSOR_API_KEY, ownerKey: `gateway:${hashKey(LOCAL_API_KEY)}` };
    }
    // Still accept a real Cursor key when gateway mode is on (ops convenience).
    if (CURSOR_API_KEY && token === CURSOR_API_KEY) {
      return { cursorApiKey: CURSOR_API_KEY, ownerKey: `direct:${hashKey(token)}` };
    }
    if (!CURSOR_API_KEY) {
      // Gateway key required; treat non-matching as unauthorized.
      return null;
    }
    // Unknown bearer while CURSOR_API_KEY is set: reject (don't forward random tokens).
    return null;
  }

  // Direct mode: client Bearer is the Cursor API key.
  // Optional: if CURSOR_API_KEY is set and matches, same key.
  return { cursorApiKey: token, ownerKey: `direct:${hashKey(token)}` };
}

function hashKey(value: string): string {
  // Short non-crypto fingerprint for in-memory partitioning (not a secret store).
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Response state (previous_response_id)
// ---------------------------------------------------------------------------

interface StoredResponseState {
  ownerKey: string;
  id: string;
  response?: Record<string, unknown>;
  inputItems: unknown[];
  outputItems: unknown[];
  sdkSessionKey?: string;
  updatedAt: number;
}

const responseState = new Map<string, StoredResponseState>();

function responseStateKey(ownerKey: string, responseId: string): string {
  return `${ownerKey}:${responseId}`;
}

function getResponseState(ownerKey: string, responseId: string): StoredResponseState | undefined {
  return responseState.get(responseStateKey(ownerKey, responseId));
}

function storeResponseState(input: {
  ownerKey: string;
  id: string;
  response: Record<string, unknown>;
  inputItems: unknown[];
  outputItems: unknown[];
  store: boolean;
  sdkSessionKey?: string;
}): void {
  const key = responseStateKey(input.ownerKey, input.id);
  responseState.set(key, {
    ownerKey: input.ownerKey,
    id: input.id,
    response: input.store ? input.response : undefined,
    inputItems: input.store ? input.inputItems : [],
    outputItems: input.outputItems,
    sdkSessionKey: input.sdkSessionKey,
    updatedAt: Date.now()
  });
  if (responseState.size <= RESPONSE_STATE_LIMIT) return;
  const entries = [...responseState.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [k] of entries.slice(0, responseState.size - RESPONSE_STATE_LIMIT)) {
    responseState.delete(k);
  }
}

function deleteResponseState(ownerKey: string, responseId: string): boolean {
  return responseState.delete(responseStateKey(ownerKey, responseId));
}

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

interface BridgeInput {
  apiKey: string;
  prompt: string;
  model: string;
  sessionKey: string;
  workingDirectory: string;
  streamEvents: boolean;
  tools: unknown[];
}

interface BridgeOutput {
  text: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  agentID: string;
  runID: string;
  status: string;
}

interface BridgeStreamEvent {
  type: string;
  text?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  output?: { text: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> };
  error?: { message?: string };
}

function workingDirectoryFor(prepared: { toolContext?: { workingDirectory?: string } }): string {
  return prepared.toolContext?.workingDirectory?.trim() || DEFAULT_WORKING_DIRECTORY;
}

function bridgeHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    ...(BRIDGE_TOKEN ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {})
  };
}

async function callSdkBridge(input: BridgeInput): Promise<BridgeOutput> {
  let response: Response;
  try {
    response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify(input)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SDK bridge unreachable";
    throw new HttpError(`SDK bridge unreachable: ${message}`, 502, "cursor_sdk_error");
  }

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new HttpError(
      error.error?.message || `SDK bridge error: ${response.status}`,
      response.status >= 400 && response.status < 600 ? response.status : 502,
      "cursor_sdk_error"
    );
  }

  return response.json() as Promise<BridgeOutput>;
}

async function* streamSdkBridge(input: BridgeInput): AsyncGenerator<BridgeStreamEvent> {
  let response: Response;
  try {
    response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify(input)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SDK bridge unreachable";
    throw new HttpError(`SDK bridge unreachable: ${message}`, 502, "cursor_sdk_error");
  }

  if (!response.ok || !response.body) {
    throw new HttpError(`SDK bridge error: ${response.status}`, response.status || 502, "cursor_sdk_error");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed) as BridgeStreamEvent;
    }
  }

  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as BridgeStreamEvent;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizeApiPath(pathname: string): string {
  let value = pathname;
  try {
    value = decodeURIComponent(pathname);
  } catch {
    // keep raw
  }
  // strip trailing slash except root
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);

  if (value === "/models" || value.startsWith("/models/")) return `/v1${value}`;
  if (value === "/chat/completions") return "/v1/chat/completions";
  if (value === "/completions") return "/v1/completions";
  if (value === "/responses" || value.startsWith("/responses/")) return `/v1${value}`;
  return value;
}

function sessionAffinity(request: Request): string {
  return (
    request.headers.get("x-session-affinity")?.trim() ||
    request.headers.get("x-opencode-session-id")?.trim() ||
    request.headers.get("x-opencode-session")?.trim() ||
    crypto.randomUUID()
  );
}

function previousResponseIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { previous_response_id?: unknown }).previous_response_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findModel(id: string): Record<string, unknown> | undefined {
  const models = (localModelList().data as Array<Record<string, unknown>>) ?? [];
  const normalized = id.trim().toLowerCase();
  return models.find((item) => String(item.id || "").toLowerCase() === normalized);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function streamChatCompletion(
  prepared: ReturnType<typeof prepareChatRequest>,
  apiKey: string,
  sessionKey: string,
  id: string,
  created: number
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: ReturnType<typeof toOpenAiToolCalls> = [];

    try {
      await writer.write(chatChunk({ id, created, model: prepared.model, role: "assistant" }));

      for await (const event of streamSdkBridge({
        apiKey,
        prompt: prepared.prompt.text,
        model: prepared.cursorModel?.id || prepared.model,
        sessionKey,
        workingDirectory: workingDirectoryFor(prepared),
        streamEvents: true,
        tools: prepared.tools
      })) {
        if (event.type === "text" && event.text) {
          text += event.text;
          await writer.write(chatChunk({ id, created, model: prepared.model, delta: event.text }));
        } else if (event.type === "tool_call" && event.toolCall) {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: prepared.tools,
            responseId: id,
            startIndex: toolCallCount,
            context: prepared.toolContext
          });
          if (toolCall) {
            finishReason = "tool_calls";
            streamedToolCalls.push(toolCall);
            await writer.write(
              chatChunk({
                id,
                created,
                model: prepared.model,
                toolCall: { index: toolCallCount, value: toolCall }
              })
            );
            toolCallCount += 1;
          }
        } else if (event.type === "thinking" && event.text) {
          await writer.write(
            chatChunk({ id, created, model: prepared.model, reasoningContent: event.text })
          );
        } else if (event.type === "done") {
          text = event.output?.text ?? text;
        } else if (event.type === "error") {
          throw new HttpError(
            event.error?.message || "SDK bridge stream error",
            500,
            "cursor_sdk_error"
          );
        } else if (event.type) {
          console.warn("[API server] Unknown bridge event type:", event.type);
        }
      }

      const completionChars = completionCharsFromOutput(text, streamedToolCalls);
      await writer.write(chatChunk({ id, created, model: prepared.model, finish: true, finishReason }));
      if (prepared.includeUsage) {
        await writer.write(
          chatUsageChunk({
            id,
            created,
            model: prepared.model,
            promptChars: prepared.promptChars,
            completionChars
          })
        );
      }
      await writer.write(doneChunk());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer.write(
        encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error")
      );
    } finally {
      await writer.close().catch(() => undefined);
    }
  };

  pump().catch((error) => {
    console.error("Stream pump error:", error instanceof Error ? error.message : error);
  });
  return sseResponse(readable);
}

async function handleChatCompletions(request: Request, auth: ResolvedAuth): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  const requestedModel =
    typeof (body as { model?: unknown })?.model === "string"
      ? (body as { model: string }).model
      : "composer-2.5";
  assertModelAllowed(requestedModel, ALLOWED_MODEL_IDS);
  const cursorModel = resolveCursorModel(requestedModel);
  const prepared = prepareChatRequest(body, cursorModel);

  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const sessionKey = sessionAffinity(request);

  if (prepared.stream) {
    return streamChatCompletion(prepared, auth.cursorApiKey, sessionKey, id, created);
  }

  const output = await callSdkBridge({
    apiKey: auth.cursorApiKey,
    prompt: prepared.prompt.text,
    model: cursorModel?.id || prepared.model,
    sessionKey,
    workingDirectory: workingDirectoryFor(prepared),
    streamEvents: false,
    tools: prepared.tools
  });

  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });

  return json(
    chatCompletionResponse({
      id,
      created,
      model: prepared.model,
      text: output.text,
      toolCalls,
      promptChars: prepared.promptChars,
      metadata: prepared.responseMetadata
    })
  );
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function streamResponsesCompletion(
  prepared: ReturnType<typeof prepareResponsesRequest>,
  apiKey: string,
  sessionKey: string,
  id: string,
  created: number,
  auth: ResolvedAuth
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    const streamedToolCalls: ReturnType<typeof toOpenAiToolCalls> = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;

    try {
      for (const event of responseCreatedEvents({
        id,
        created,
        model: prepared.model,
        metadata: prepared.responseMetadata
      })) {
        await writer.write(event);
      }

      for await (const event of streamSdkBridge({
        apiKey,
        prompt: prepared.prompt.text,
        model: prepared.cursorModel?.id || prepared.model,
        sessionKey,
        workingDirectory: workingDirectoryFor(prepared),
        streamEvents: true,
        tools: prepared.tools
      })) {
        if (event.type === "text" && event.text) {
          text += event.text;
          if (responseTextOutputIndex === null) {
            responseTextOutputIndex = responseNextOutputIndex;
            responseNextOutputIndex += 1;
            for (const chunk of responseTextStartEvents({ id, outputIndex: responseTextOutputIndex })) {
              await writer.write(chunk);
            }
          }
          await writer.write(responseDeltaEvent({ id, delta: event.text, outputIndex: responseTextOutputIndex }));
        } else if (event.type === "tool_call" && event.toolCall) {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: prepared.tools,
            responseId: id,
            startIndex: toolCallCount,
            context: prepared.toolContext
          });
          if (!toolCall) continue;
          streamedToolCalls.push(toolCall);
          for (const chunk of responseToolCallEvents({
            id,
            toolCall,
            outputIndex: responseNextOutputIndex
          })) {
            await writer.write(chunk);
          }
          responseNextOutputIndex += 1;
          toolCallCount += 1;
        } else if (event.type === "done") {
          text = event.output?.text ?? text;
        } else if (event.type === "error") {
          throw new HttpError(
            event.error?.message || "SDK bridge stream error",
            500,
            "cursor_sdk_error"
          );
        }
      }

      if (responseTextOutputIndex === null && !streamedToolCalls.length) {
        responseTextOutputIndex = responseNextOutputIndex;
        responseNextOutputIndex += 1;
        for (const chunk of responseTextStartEvents({ id, outputIndex: responseTextOutputIndex })) {
          await writer.write(chunk);
        }
      }

      for (const event of responseDoneEvents({
        id,
        created,
        model: prepared.model,
        text,
        toolCalls: streamedToolCalls,
        promptChars: prepared.promptChars,
        metadata: prepared.responseMetadata,
        textStarted: responseTextOutputIndex !== null,
        textOutputIndex: responseTextOutputIndex ?? 0
      })) {
        await writer.write(event);
      }

      const completed = responseObject({
        id,
        created,
        model: prepared.model,
        text,
        toolCalls: streamedToolCalls,
        promptChars: prepared.promptChars,
        metadata: prepared.responseMetadata
      });
      storeResponseState({
        ownerKey: auth.ownerKey,
        id,
        response: completed,
        inputItems: prepared.responseInputItems ?? [],
        outputItems: (completed.output as unknown[]) ?? [],
        store: prepared.storeResponse !== false,
        sdkSessionKey: sessionKey
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer.write(
        encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error")
      );
    } finally {
      await writer.close().catch(() => undefined);
    }
  };

  pump().catch((error) => {
    console.error("Responses stream pump error:", error instanceof Error ? error.message : error);
  });
  return sseResponse(readable);
}

async function handleCreateResponse(request: Request, auth: ResolvedAuth): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  const requestedModel =
    typeof (body as { model?: unknown })?.model === "string"
      ? (body as { model: string }).model
      : "composer-2.5";
  assertModelAllowed(requestedModel, ALLOWED_MODEL_IDS);
  const cursorModel = resolveCursorModel(requestedModel);

  const previousResponseId = previousResponseIdFromBody(body);
  const previousState = previousResponseId ? getResponseState(auth.ownerKey, previousResponseId) : undefined;
  if (previousResponseId && !previousState) {
    throw new HttpError("Response not found", 404, "not_found");
  }

  const prepared = prepareResponsesRequest(body, cursorModel, {
    previousOutput: previousState?.outputItems,
    previousInputItems: previousState?.inputItems
  });

  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const sessionKey = previousState?.sdkSessionKey || sessionAffinity(request);

  if (prepared.stream) {
    return streamResponsesCompletion(prepared, auth.cursorApiKey, sessionKey, id, created, auth);
  }

  const output = await callSdkBridge({
    apiKey: auth.cursorApiKey,
    prompt: prepared.prompt.text,
    model: cursorModel?.id || prepared.model,
    sessionKey,
    workingDirectory: workingDirectoryFor(prepared),
    streamEvents: false,
    tools: prepared.tools
  });

  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });

  const response = responseObject({
    id,
    created,
    model: prepared.model,
    text: output.text,
    toolCalls,
    promptChars: prepared.promptChars,
    metadata: prepared.responseMetadata
  });

  storeResponseState({
    ownerKey: auth.ownerKey,
    id,
    response,
    inputItems: prepared.responseInputItems ?? [],
    outputItems: (response.output as unknown[]) ?? [],
    store: prepared.storeResponse !== false,
    sdkSessionKey: sessionKey
  });

  return json(response);
}

async function handleResponseState(
  request: Request,
  auth: ResolvedAuth,
  responseId: string,
  kind: "response" | "input_items" | "cancel"
): Promise<Response> {
  const state = getResponseState(auth.ownerKey, responseId);
  if (!state?.response && kind !== "cancel") {
    throw new HttpError("Response not found", 404, "not_found");
  }

  if (kind === "response") {
    if (request.method === "GET" || request.method === "HEAD") {
      return json(state!.response);
    }
    if (request.method === "DELETE") {
      deleteResponseState(auth.ownerKey, responseId);
      return json({ id: responseId, object: "response", deleted: true });
    }
    return notFound();
  }

  if (kind === "input_items") {
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    return json(responseInputItemsObject(state!.inputItems));
  }

  if (kind === "cancel") {
    if (request.method !== "POST") return notFound();
    throw new HttpError(
      "Only background responses can be cancelled. The local server runs responses synchronously.",
      400,
      "invalid_request_error"
    );
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Discovery / health
// ---------------------------------------------------------------------------

function discoveryPayload(): Record<string, unknown> {
  return {
    name: "api-for-cursor-local",
    ok: true,
    host: HOST,
    port: PORT,
    workingDirectory: DEFAULT_WORKING_DIRECTORY,
    bridgeUrl: BRIDGE_URL,
    auth: {
      gateway: Boolean(LOCAL_API_KEY),
      cursorKeyConfigured: Boolean(CURSOR_API_KEY)
    },
    models: (localModelList() as { data: Array<{ id: string }> }).data.map((m) => m.id),
    endpoints: {
      models: "/v1/models",
      chat_completions: "/v1/chat/completions",
      responses: "/v1/responses",
      response_input_tokens: "POST /v1/responses/input_tokens",
      compact_response: "POST /v1/responses/compact",
      delete_response: "DELETE /v1/responses/{response_id}",
      cancel_response: "POST /v1/responses/{response_id}/cancel"
    },
    features: {
      chat_completions: true,
      responses: true,
      stateful_responses: true,
      response_input_tokens: true,
      response_compaction: false,
      response_cancellation: false,
      streaming: true,
      gateway_auth: Boolean(LOCAL_API_KEY)
    },
    responses: {
      sessions: responseState.size,
      maxStored: RESPONSE_STATE_LIMIT
    }
  };
}

function estimateInputTokens(body: unknown): Response {
  const text = JSON.stringify(body ?? "");
  // Rough char/4 estimate — same spirit as local macOS helper, not billable truth.
  const tokens = Math.max(1, Math.ceil(text.length / 4));
  return json({
    object: "response.input_tokens",
    input_tokens: tokens,
    input_tokens_details: { cached_tokens: 0 }
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse();

  const url = new URL(request.url);
  const path = normalizeApiPath(url.pathname);

  if ((request.method === "GET" || request.method === "HEAD") && (path === "/" || path === "/health" || path === "/v1")) {
    return json(discoveryPayload());
  }

  if ((request.method === "GET" || request.method === "HEAD") && path === "/v1/models") {
    // Models listing is public (ids only); Hermes probes this without secrets sometimes.
    return json(localModelList());
  }

  const modelMatch = /^\/v1\/models\/([^/]+)$/.exec(path);
  if ((request.method === "GET" || request.method === "HEAD") && modelMatch) {
    const model = findModel(modelMatch[1]);
    if (!model) return openAiError(`The model '${modelMatch[1]}' does not exist`, 404, "model_not_found", "model");
    return json(model);
  }

  // Remaining routes require auth.
  let auth: ResolvedAuth;
  try {
    const resolved = resolveAuth(request);
    if (!resolved) return unauthorized();
    auth = resolved;
  } catch (error) {
    return errorResponse(error);
  }

  if (request.method === "POST" && path === "/v1/chat/completions") {
    return handleChatCompletions(request, auth);
  }

  if (request.method === "POST" && path === "/v1/responses") {
    return handleCreateResponse(request, auth);
  }

  if (request.method === "POST" && path === "/v1/responses/input_tokens") {
    const body = await parseJsonBody<unknown>(request);
    return estimateInputTokens(body);
  }

  if (request.method === "POST" && path === "/v1/responses/compact") {
    throw new HttpError("response compaction is not supported on the local server", 400, "unsupported_parameter");
  }

  if (request.method === "POST" && path === "/v1/completions") {
    throw new HttpError(
      "Legacy /v1/completions is not supported. Use /v1/chat/completions or /v1/responses.",
      400,
      "unsupported_endpoint"
    );
  }

  const cancelMatch = /^\/v1\/responses\/([^/]+)\/cancel$/.exec(path);
  if (cancelMatch) {
    return handleResponseState(request, auth, cancelMatch[1], "cancel");
  }

  const inputItemsMatch = /^\/v1\/responses\/([^/]+)\/input_items$/.exec(path);
  if (inputItemsMatch) {
    return handleResponseState(request, auth, inputItemsMatch[1], "input_items");
  }

  const responseMatch = /^\/v1\/responses\/([^/]+)$/.exec(path);
  if (responseMatch) {
    return handleResponseState(request, auth, responseMatch[1], "response");
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch (error) {
      return errorResponse(error);
    }
  }
});

console.log(`API server listening on http://${HOST}:${PORT}`);
console.log(`  bridge:     ${BRIDGE_URL}`);
console.log(`  cwd:        ${DEFAULT_WORKING_DIRECTORY}`);
console.log(`  gateway:    ${LOCAL_API_KEY ? "LOCAL_API_KEY enabled" : "direct Cursor bearer"}`);
console.log(`  cursor key: ${CURSOR_API_KEY ? "configured via env" : "from request bearer"}`);

process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  server.stop(true);
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down gracefully...");
  server.stop(true);
  process.exit(0);
});
