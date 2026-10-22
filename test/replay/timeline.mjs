import assert from "node:assert/strict";

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const graphemes = (text) => [...segmenter.segment(text)].map(({ segment }) => segment);

/** Fixed source schedule. It never reads queue state or waits for display drain. */
export function recordedTimeline(fixture, scenario = "fixed") {
  assert.ok(["fixed", "continuous-tools"].includes(scenario), "unknown source scenario");
  const events = [];
  const arrive = (kind, id, text, batch, startAt) => {
    const parts = graphemes(text);
    for (let end = batch, index = 0; end < parts.length + batch; end += batch, index += 1) {
      events.push({ atMs: startAt + index * 100, kind, id, text: parts.slice(0, Math.min(end, parts.length)).join("") });
    }
    return startAt + Math.ceil(parts.length / batch) * 100;
  };
  const thinkingCompleteAt = arrive("thinking-arrival", "first", fixture.thinking, 12, 300);
  const toolCount = scenario === "continuous-tools" ? 6 : 1;
  events.push({ atMs: thinkingCompleteAt, kind: "thinking-complete-tool-call", toolCount });
  const toolEnds = [];
  for (let index = 0; index < toolCount; index += 1) {
    const id = `recorded-bash-${index}`;
    const startAt = thinkingCompleteAt + index * 150;
    events.push({ atMs: startAt, kind: "tool-start", id });
    const endAt = arrive("tool-output-arrival", id, fixture.output, 160, startAt);
    events.push({ atMs: endAt, kind: "tool-complete", id, text: fixture.output });
    toolEnds.push(endAt);
  }
  // Deliberately independent of drain. In the continuous-tools scenario this
  // input overlaps the remaining result streams; all six commands are replayed
  // fixture text and are never executed.
  const nextStartAt = toolEnds[0] + 100;
  events.push({ atMs: nextStartAt, kind: "next-assistant-created", id: "next" });
  const nextEndAt = arrive("next-thinking-arrival", "next", fixture.nextThinking, 10, nextStartAt);
  events.push({ atMs: nextEndAt, kind: "source-complete" });
  events.sort((left, right) => left.atMs - right.atMs);
  return {
    events,
    sourceEndAtMs: Math.max(nextEndAt, ...toolEnds),
    metadata: {
      scenario,
      synthetic: true,
      sourceArrivalIntervalMs: 100,
      thinkingCompleteAtMs: thinkingCompleteAt,
      firstToolCompleteAtMs: toolEnds[0],
      lastToolCompleteAtMs: toolEnds.at(-1),
      nextThinkingStartsAtMs: nextStartAt,
      nextThinkingSourceEndAtMs: nextEndAt,
      tools: toolCount,
      note: "Recorded text, synthetic absolute source times; continuous-tools repeats the fixture command/output in six overlapping tool instances. No command is executed.",
    },
  };
}

export function summary(samples) {
  const sorted = samples.filter(Number.isFinite).toSorted((a, b) => a - b);
  const at = (quantile) => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}
