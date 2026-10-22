import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piRequire, piRoot } from "./pi-host.mjs";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: pathToFileURL(join(piRoot, "dist/index.js")).href, shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-tui") {
    return { url: pathToFileURL(piRequire.resolve(specifier)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
