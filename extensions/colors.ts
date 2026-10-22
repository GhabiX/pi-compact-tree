/**
 * Plugin-owned colors use the xterm 256 palette at the terminal boundary.
 * This keeps semantic colors stable through Herdr/Mosh without capability
 * detection or theme-generated truecolor sequences.
 */
export const UI_COLORS = {
  success: 35,
  error: 167,
  warning: 178,
  dim: 241,
  muted: 244,
} as const;

export type UiColor = keyof typeof UI_COLORS;

export function fg256(color: UiColor, text: string): string {
  return `\x1b[38;5;${UI_COLORS[color]}m${text}\x1b[39m`;
}

/**
 * An active item's marker breathes on the pulse: brightness (1 − cos 2πt/BREATH_MS)/2
 * over two beats of ♩ = 100, sampled onto the xterm gray ramp from BREATH_LOW to BREATH_HIGH.
 */
export const BREATH_MS = 1200;
const BREATH_LOW = 240, BREATH_HIGH = 253;

/** The gray of the breath at time `now`; renders only change when it does. */
export function breath(now: number): number {
  return BREATH_LOW + Math.round((BREATH_HIGH - BREATH_LOW) * (1 - Math.cos(2 * Math.PI * now / BREATH_MS)) / 2);
}

export function pulse256(gray: number, text: string): string {
  return `\x1b[38;5;${gray}m${text}\x1b[39m`;
}

export function spineSuccess(text: string): string {
  return fg256("success", text);
}
