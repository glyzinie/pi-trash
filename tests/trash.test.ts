import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import trashExtension, {
  selectTopLevelTrashEntries,
  validateTrashPath,
} from "../index.ts";

type Exec = ExtensionAPI["exec"];
type ExecResult = Awaited<ReturnType<Exec>>;
type TrashOptions = NonNullable<Parameters<typeof trashExtension>[1]>;
const success: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };

const temporaryRoots: string[] = [];

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  temporaryRoots.push(root);
  return realpathSync(root);
}

function trashTool(exec: Exec = async () => success, options: TrashOptions = {}) {
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const calls: Parameters<Exec>[] = [];
  trashExtension({
    registerTool(definition: NonNullable<typeof tool>) {
      tool = definition;
    },
    exec(...args: Parameters<Exec>) {
      calls.push(args);
      return exec(...args);
    },
  } as unknown as ExtensionAPI, {
    platform: "darwin",
    isAvailable: async () => true,
    ...options,
  });
  if (!tool) throw new Error("trash was not registered");
  const definition = tool;
  return {
    calls,
    definition,
    execute(paths: string[], cwd: string, signal?: AbortSignal) {
      return definition.execute("trash-test", { paths }, signal, undefined, { cwd } as ExtensionContext);
    },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("validateTrashPath", () => {
  test("resolves workspace paths and strips the model-facing @ prefix", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const target = join(workspace, "file.txt");
    writeFileSync(target, "test");

    expect(await validateTrashPath("file.txt", workspace)).toBe(target);
    expect(await validateTrashPath("@file.txt", workspace)).toBe(target);
  });

  test("rejects the workspace root and paths outside it", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");

    await expect(validateTrashPath(".", workspace)).rejects.toThrow(
      "Refusing to trash the workspace root",
    );
    await expect(validateTrashPath("../outside", workspace)).rejects.toThrow(
      "Refusing to trash path outside workspace",
    );
  });

  test("collapses nested targets under their selected parent", () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const parent = join(workspace, "dir");
    const child = join(parent, "file.txt");
    const other = join(workspace, "other.txt");
    const selected = selectTopLevelTrashEntries(new Map([
      [child, "dir/file.txt"],
      [other, "other.txt"],
      [parent, "dir"],
    ]));

    expect([...selected]).toEqual([
      [other, "other.txt"],
      [parent, "dir"],
    ]);
  });

  test("allows final and dangling symlinks but rejects a parent outside workspace", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const outside = temporaryRoot("pi-trash-outside");
    const outsideFile = join(outside, "outside.txt");
    writeFileSync(outsideFile, "outside");

    const finalLink = join(workspace, "final-link");
    symlinkSync(outsideFile, finalLink);
    expect(await validateTrashPath("final-link", workspace)).toBe(finalLink);
    const dangling = join(workspace, "dangling");
    symlinkSync(join(outside, "missing.txt"), dangling);
    expect(await validateTrashPath("dangling", workspace)).toBe(dangling);

    const linkedParent = join(workspace, "linked-parent");
    symlinkSync(outside, linkedParent, "dir");
    await expect(
      validateTrashPath(join(linkedParent, "outside.txt"), workspace),
    ).rejects.toThrow("Refusing path through symlinked parent outside workspace");
  });

  test("accepts absolute workspace aliases without dereferencing the final symlink", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const aliases = temporaryRoot("pi-trash-aliases");
    const alias = join(aliases, "workspace");
    symlinkSync(workspace, alias, "dir");
    const target = join(workspace, "file.txt");
    writeFileSync(target, "file");
    symlinkSync(aliases, join(workspace, "link"), "dir");

    expect(await validateTrashPath(join(alias, "file.txt"), workspace)).toBe(target);
    expect(await validateTrashPath(join(alias, "link"), workspace)).toBe(join(workspace, "link"));
    await expect(validateTrashPath(alias, workspace)).rejects.toThrow("outside workspace");
  });

  test("rejects the real workspace root reached through an aliased parent", async () => {
    const root = temporaryRoot("pi-trash-root");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const aliases = temporaryRoot("pi-trash-aliases");
    const alias = join(aliases, "parent");
    symlinkSync(root, alias, "dir");
    await expect(validateTrashPath(join(alias, "workspace"), workspace)).rejects.toThrow(
      "Refusing to trash the workspace root",
    );
  });

  test("does not cache a symlinked parent's identity across validations", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const inside = join(workspace, "inside");
    mkdirSync(inside);
    writeFileSync(join(inside, "file.txt"), "inside");
    const outside = temporaryRoot("pi-trash-outside");
    writeFileSync(join(outside, "file.txt"), "outside");
    const link = join(workspace, "parent");
    symlinkSync(inside, link, "dir");
    expect(await validateTrashPath(join(link, "file.txt"), workspace)).toBe(join(inside, "file.txt"));
    rmSync(link);
    symlinkSync(outside, link, "dir");
    await expect(validateTrashPath(join(link, "file.txt"), workspace)).rejects.toThrow(
      "Refusing path through symlinked parent outside workspace",
    );
  });

  test("rejects missing entries", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    await expect(validateTrashPath("missing.txt", workspace)).rejects.toThrow("ENOENT");
  });
});

describe("selectTopLevelTrashEntries", () => {
  test("preserves order and does not confuse common name prefixes with parents", () => {
    const entries = new Map([
      ["/workspace/a/deep/file", "deep"],
      ["/workspace/ab", "prefix"],
      ["/workspace/a", "parent"],
      ["/workspace/b/c", "child"],
      ["/workspace/b", "other parent"],
    ]);
    expect([...selectTopLevelTrashEntries(entries)]).toEqual([
      ["/workspace/ab", "prefix"],
      ["/workspace/a", "parent"],
      ["/workspace/b", "other parent"],
    ]);
    expect(selectTopLevelTrashEntries(new Map()).size).toBe(0);
  });

  test("handles a full 100-path batch with deeply nested selections", () => {
    const entries = new Map<string, string>();
    for (let index = 0; index < 100; index++) {
      const path = `/workspace/${"dir/".repeat(99 - index)}file`;
      entries.set(path, String(index));
    }
    expect(selectTopLevelTrashEntries(entries)).toEqual(entries);
    const parent = new Map([...entries, ["/workspace", "root"]]);
    expect([...selectTopLevelTrashEntries(parent)]).toEqual([["/workspace", "root"]]);
  });
});

describe("trash tool", () => {
  test("deduplicates aliases and nested paths into one sequential command", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    mkdirSync(join(workspace, "dir"));
    writeFileSync(join(workspace, "dir", "file.txt"), "file");
    writeFileSync(join(workspace, "other.txt"), "other");
    const aliases = temporaryRoot("pi-trash-aliases");
    const alias = join(aliases, "workspace");
    symlinkSync(workspace, alias, "dir");
    const instance = trashTool();
    const signal = new AbortController().signal;
    const result = await instance.execute([
      "dir/file.txt", "dir", "dir", "@dir", join(alias, "other.txt"), "other.txt",
    ], alias, signal);
    const targets = [join(workspace, "dir"), join(workspace, "other.txt")];
    expect(instance.definition.executionMode).toBe("sequential");
    expect(instance.calls).toEqual([["/usr/bin/trash", ["-s", ...targets], { cwd: workspace, signal }]]);
    expect(result.details).toEqual({ paths: targets });
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringContaining("1 nested path covered by a parent path"),
    }]);
  });

  test("validates every path before moving anything", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    writeFileSync(join(workspace, "file.txt"), "file");
    const instance = trashTool();
    await expect(instance.execute(["file.txt", "missing.txt"], workspace)).rejects.toThrow("ENOENT");
    expect(instance.calls).toHaveLength(0);
  });

  test("does not execute a command when already aborted or cancelled during preflight", async () => {
    const controller = new AbortController();
    controller.abort();
    const instance = trashTool();
    await expect(instance.execute(["file.txt"], "/missing", controller.signal)).rejects.toThrow("trash aborted");
    expect(instance.calls).toHaveLength(0);

    const workspace = temporaryRoot("pi-trash-workspace");
    writeFileSync(join(workspace, "file.txt"), "file");
    const available = Promise.withResolvers<boolean>();
    const waiting = trashTool(undefined, { isAvailable: () => available.promise });
    const pendingController = new AbortController();
    const result = waiting.execute(["file.txt"], workspace, pendingController.signal);
    pendingController.abort();
    available.resolve(true);
    await expect(result).rejects.toThrow("trash aborted");
    expect(waiting.calls).toHaveLength(0);
  });

  test("rejects unsupported platforms and missing executables", async () => {
    for (const options of [
      { platform: "linux" as const },
      { isAvailable: async () => false },
    ]) {
      const instance = trashTool(undefined, options);
      await expect(instance.execute(["file.txt"], "/missing")).rejects.toThrow("macOS 15 or later");
      expect(instance.calls).toHaveLength(0);
    }
  });

  test.each([
    [{ ...success, code: 1, stderr: "permission denied" }, "permission denied"],
    [{ ...success, code: 2 }, "trash exited with code 2"],
    [{ ...success, killed: true }, "trash was terminated"],
  ] as const)("reports command failures without hiding partial moves: %j", async (response, reason) => {
    const workspace = temporaryRoot("pi-trash-workspace");
    writeFileSync(join(workspace, "file.txt"), "file");
    const instance = trashTool(async () => response);
    await expect(instance.execute(["file.txt"], workspace)).rejects.toThrow(
      `${reason}\nSome paths may already have been moved to Trash.`,
    );
  });

  test("reports an aborted command as a potentially partial move", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    writeFileSync(join(workspace, "file.txt"), "file");
    const controller = new AbortController();
    const instance = trashTool(async () => {
      controller.abort();
      return { ...success, killed: true };
    });
    await expect(instance.execute(["file.txt"], workspace, controller.signal)).rejects.toThrow(
      "trash aborted\nSome paths may already have been moved to Trash.",
    );
  });

  test("quotes control characters and limits summary entries while keeping full details", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const names = ["line\nbreak\x1b\u009b\u2028.txt", ...Array.from({ length: 11 }, (_, index) => `file-${index}.txt`)];
    for (const name of names) writeFileSync(join(workspace, name), "file");
    const result = await trashTool().execute(names, workspace);
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Expected text output");
    expect(content.text).toContain('"line\\nbreak\\u001b\\u009b\\u2028.txt"');
    expect(content.text).not.toMatch(/[\x1b\u009b\u2028]/);
    expect(content.text).toContain("…and 2 more");
    expect(content.text.split("\n")).toHaveLength(12);
    expect(result.details).toEqual({ paths: names.map((name) => join(workspace, name)) });
  });

  test("bounds long multibyte path previews without cutting Unicode characters", async () => {
    const workspace = temporaryRoot("pi-trash-workspace");
    const paths = Array.from({ length: 10 }, (_, index) => {
      const name = `file-${index}.txt`;
      writeFileSync(join(workspace, name), "file");
      return `${"😀/../".repeat(600)}${name}`;
    });
    const result = await trashTool().execute(paths, workspace);
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Expected text output");
    expect(Buffer.byteLength(content.text)).toBeLessThan(12 * 1024);
    expect(content.text).toContain("…");
    expect(content.text).not.toContain("�");
    expect(result.details).toEqual({
      paths: Array.from({ length: 10 }, (_, index) => join(workspace, `file-${index}.txt`)),
    });
  });
});
