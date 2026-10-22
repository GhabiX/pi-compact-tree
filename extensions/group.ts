/** Normalize Pi assistant/tool sources into semantic process cards. */

import {
  collapseWs,
  type InnerCall,
  type ToolStatus,
  type TreeCard,
  stripAnsi,
} from "./format.ts";

export type AssistantContent = {
  type: string;
  text?: string;
  thinking?: string;
};

export type DuckTool = {
  toolName: string;
  args?: Record<string, unknown>;
  /** True only for assistant messages observed through live session events. */
  playbackSource?: boolean;
  /** Explicit final-source signal supplied by the session lifecycle. */
  playbackEnded?: boolean;
  setExpanded?: (expanded: boolean) => void;
  isPartial?: boolean;
  executionStarted?: boolean;
  isStreaming?: boolean;
  lastMessage?: { stopReason?: string; errorMessage?: string; content?: AssistantContent[] };
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    details?: { diff?: unknown; calls?: unknown };
  };
  companions?: DuckTool[];
  /** Position of this component's native prose relative to its process node. */
  nativePlacement?: "before" | "after";
};

/** Text the tool returned so far. Codemode's first text is its fixed `Script completed` header. */
function outputText(card: DuckTool): string {
  const parts = card.result?.content?.filter((part) => part.type === "text" && part.text) ?? [];
  return stripAnsi((card.toolName === "codemode" ? parts.slice(1) : parts).map((part) => part.text).join(""));
}

export function isDuckTool(value: unknown): value is DuckTool {
  if (value === null || typeof value !== "object") return false;
  const card = value as DuckTool;
  return typeof card.toolName === "string";
}

export function hasVisibleText(message: { content?: AssistantContent[] } | undefined): boolean {
  return Boolean(message?.content?.some((block) => block.type === "text" && String(block.text ?? "").trim()));
}

export function hasThinking(message: { content?: AssistantContent[] } | undefined): boolean {
  return Boolean(
    message?.content?.some((block) => block.type === "thinking" && String(block.thinking ?? "").trim()),
  );
}

/** A completed thinking row is intentionally one compact, non-streaming line. */
export function thinkingSummary(message: { content?: AssistantContent[] } | undefined): string {
  const text = message?.content
    ?.filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? "")
    .join(" ") ?? "";
  return collapseWs(stripAnsi(text));
}

export type AssistantDuck = {
  updateContent: (message: unknown, isStreaming?: boolean) => void;
  setHiddenThinkingLabel: (label: string) => void;
  render: (width?: number) => string[];
  lastMessage?: { stopReason?: string; errorMessage?: string; content?: AssistantContent[] };
  isStreaming?: boolean;
};

export function isAssistantCard(value: unknown): value is AssistantDuck {
  if (value === null || typeof value !== "object") return false;
  const card = value as { updateContent?: unknown; setHiddenThinkingLabel?: unknown };
  return typeof card.updateContent === "function" && typeof card.setHiddenThinkingLabel === "function";
}

export type ToolLifecycle = "queued" | "running" | "completed" | "errored";

export function toolLifecycle(card: DuckTool): ToolLifecycle {
  if (card.toolName === "cache_miss") return "completed";
  if (card.toolName === "thinking") {
    if (card.isStreaming) return "running";
    const reason = card.lastMessage?.stopReason;
    if (reason === "error" || reason === "aborted") return "errored";
    return "completed";
  }
  if (card.executionStarted === false && !card.result) return "queued";
  if (!card.result || card.isPartial) return "running";
  return card.result.isError ? "errored" : "completed";
}

export function cardStatus(card: DuckTool): ToolStatus | undefined {
  if (card.toolName === "cache_miss") return "notice";
  const lifecycle = toolLifecycle(card);
  return lifecycle === "queued" ? undefined : lifecycle;
}

export function toTreeCard(card: DuckTool): TreeCard | undefined {
  const status = cardStatus(card);
  if (!status) return undefined;
  const base = { toolName: card.toolName, args: card.args ?? {}, status };
  // Thinking is a playback source, not a bounded tool-result preview. Preserve
  // every block and its order so later appends retain the existing prefix.
  if (card.toolName === "thinking") {
    const detail = card.lastMessage?.content?.filter((part) => part.type === "thinking" && part.thinking)
      .map((part) => stripAnsi(part.thinking!)).join("\n\n");
    return { ...base, ...(detail ? { detail } : {}) };
  }
  const output = outputText(card);
  const { diff, calls } = card.result?.details ?? {};
  return {
    ...base,
    ...(output ? { output } : {}),
    ...(typeof diff === "string" && diff ? { diff } : {}),
    ...(Array.isArray(calls) && calls.length ? { calls: calls as InnerCall[] } : {}),
  };
}
