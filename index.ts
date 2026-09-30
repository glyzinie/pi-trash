import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TRASH = "/usr/bin/trash";
const MAX_SUMMARY_PATHS = 10;
const MAX_DISPLAY_PATH_CHARS = 160;

interface TrashOptions {
  platform?: NodeJS.Platform;
  isAvailable?: () => Promise<boolean>;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function selectTopLevelTrashEntries(
  entries: ReadonlyMap<string, string>,
): Map<string, string> {
  const selected = new Map(entries);
  if (entries.size < 2) return selected;

  // Look up ancestors instead of comparing every pair, preserving input order.
  for (const target of entries.keys()) {
    let current = target;
    for (let parent = dirname(current); parent !== current; parent = dirname(current)) {
      if (entries.has(parent)) {
        selected.delete(target);
        break;
      }
      current = parent;
    }
  }
  return selected;
}

export async function validateTrashPath(input: string, workspace: string): Promise<string> {
  const value = input.startsWith("@") ? input.slice(1) : input;
  const target = resolve(workspace, value);
  if (target === workspace) throw new Error("Refusing to trash the workspace root");

  // Resolve only the parent: absolute workspace aliases are valid, and the
  // final symlink itself must be moved rather than its destination.
  const parent = await realpath(dirname(target));
  const canonicalTarget = resolve(parent, basename(target));
  if (canonicalTarget === workspace) throw new Error("Refusing to trash the workspace root");
  if (!isInside(parent, workspace)) {
    const reason = isInside(target, workspace)
      ? "Refusing path through symlinked parent outside workspace"
      : "Refusing to trash path outside workspace";
    throw new Error(`${reason}: ${input}`);
  }
  await lstat(canonicalTarget);
  return canonicalTarget;
}

function displayPath(path: string): string {
  const characters = Array.from(path);
  const preview = characters.length > MAX_DISPLAY_PATH_CHARS
    ? `${characters.slice(0, MAX_DISPLAY_PATH_CHARS).join("")}…`
    : path;
  return JSON.stringify(preview).replace(/[\x7f-\x9f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export default function trashExtension(pi: ExtensionAPI, options: TrashOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const isAvailable = options.isAvailable ?? (async () => {
    try {
      await access(TRASH, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

  pi.registerTool({
    name: "trash",
    label: "trash",
    description: "Move files or directories inside the current workspace to the macOS Trash.",
    promptSnippet: "Move workspace files or directories to the macOS Trash",
    promptGuidelines: [
      "Use trash instead of bash rm or rmdir when deleting files or directories inside the workspace.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 100,
        description: "Workspace-relative or absolute paths to move to Trash. Globs are not expanded.",
      }),
    }),
    executionMode: "sequential",

    async execute(_id, { paths }, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("trash aborted");
      if (platform !== "darwin" || !(await isAvailable())) {
        throw new Error("trash requires macOS 15 or later");
      }

      const workspace = await realpath(ctx.cwd);
      if (signal?.aborted) throw new Error("trash aborted");

      // The schema caps this batch at 100 paths. Validate the whole batch before
      // moving anything, and avoid duplicate input I/O without caching identities.
      const validated = await Promise.all([...new Set(paths)].map(async (input) =>
        [await validateTrashPath(input, workspace), input] as const
      ));
      const entries = new Map<string, string>();
      for (const [target, input] of validated) {
        if (!entries.has(target)) entries.set(target, input);
      }

      const selectedEntries = selectTopLevelTrashEntries(entries);
      const targets = [...selectedEntries.keys()];
      if (signal?.aborted) throw new Error("trash aborted");
      const result = await pi.exec(TRASH, ["-s", ...targets], {
        cwd: workspace,
        signal,
      });
      if (result.killed || result.code !== 0) {
        const reason = result.killed
          ? (signal?.aborted ? "trash aborted" : "trash was terminated")
          : (result.stderr.trim() || `trash exited with code ${result.code}`);
        throw new Error(`${reason}\nSome paths may already have been moved to Trash.`);
      }

      const moved = [...selectedEntries.values()];
      const shown = moved.slice(0, MAX_SUMMARY_PATHS);
      const omitted = moved.length - shown.length;
      const covered = entries.size - selectedEntries.size;
      const summary = shown.map((path) => `- ${displayPath(path)}`).join("\n") +
        (omitted > 0 ? `\n- …and ${omitted} more` : "") +
        (covered > 0
          ? `\n(${covered} nested path${covered === 1 ? "" : "s"} covered by a parent path.)`
          : "");

      return {
        content: [{ type: "text" as const, text: `Moved to Trash:\n${summary}` }],
        details: { paths: targets },
      };
    },
  });
}
