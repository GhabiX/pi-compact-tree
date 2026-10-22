# Session replay text

`session-slice.json` is a synthetic session excerpt used by the manual replay
tool (`test/replay/compat.mjs`): one thinking block, one bash call with its
output, and the thinking that follows. The text is an excerpt; outputBytes and
outputLines describe a longer result. Replay arrival times are synthetic, and
commands in this fixture are never executed.
