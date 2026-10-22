/**
 * Deterministic model for the TUI end-to-end test: real Pi, real plugin, scripted replies.
 *
 * Directives in the latest user message:
 *   E2E:tools <tag>  thinking + two parallel reads, then thinking + a bash call, then reply "DONE <tag>"
 *   E2E:fail <tag>   thinking + a failing bash call, then reply "DONE <tag>"
 *   E2E:wait <ms>    wait <ms> before replying "DONE <ms>", so the agent stays busy
 *   anything else    reply "DONE"
 * The step is the number of assistant messages since the latest user message, so replies need no state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
  type AssistantMessage, type FauxResponseFactory,
} from "@earendil-works/pi-ai";

const THINKING = "Planning the next step: read the two notes, then check the shell. **Keep it short** and report back.";

const respond: FauxResponseFactory = context => {
  const last = context.messages.findLastIndex(message => message.role === "user");
  const step = context.messages.slice(last + 1).filter(message => message.role === "assistant").length;
  const directive = /E2E:(\w+)\s*(\S*)/.exec(textOf(context.messages[last]?.content)) ?? [];
  if (directive[1] === "wait") return new Promise(done => setTimeout(() => done(act("", directive[2]!, step)), Number(directive[2])));
  return act(directive[1] ?? "", directive[2] ?? "", step);
};

function act(kind: string, tag: string, step: number): AssistantMessage {
  if (kind === "tools" && step === 0) {
    return fauxAssistantMessage([fauxThinking(THINKING), fauxToolCall("read", { path: "notes/a.md" }), fauxToolCall("read", { path: "notes/b.md" })],
      { stopReason: "toolUse" });
  }
  if (kind === "tools" && step === 1) {
    return fauxAssistantMessage([fauxThinking("Both notes are there. Now the shell."), fauxToolCall("bash", { command: `echo shell-${tag}` })],
      { stopReason: "toolUse" });
  }
  if (kind === "fail" && step === 0) {
    return fauxAssistantMessage([fauxThinking("Try a command that fails."), fauxToolCall("bash", { command: "echo broken >&2; exit 3" })],
      { stopReason: "toolUse" });
  }
  return fauxAssistantMessage([fauxText(`DONE ${tag}`.trim())]);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => (part as { type?: string }).type === "text" ? [(part as { text: string }).text] : []).join("");
}

export default function scriptedProvider(pi: ExtensionAPI): void {
  const model = { id: "script", name: "ui2tree e2e script", reasoning: true, input: ["text" as const],
    contextWindow: 200_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const core = createFauxCore({ api: "ui2tree-e2e", provider: "ui2tree-e2e", models: [model], tokensPerSecond: 400 });
  core.setResponses(Array.from({ length: 10_000 }, () => respond));
  pi.registerProvider("ui2tree-e2e", {
    name: "ui2tree e2e", baseUrl: "http://ui2tree-e2e.invalid", apiKey: "ui2tree-e2e", api: core.api, models: [model],
    streamSimple: core.streamSimple,
  });
}
