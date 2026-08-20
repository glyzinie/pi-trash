# pi-trash

Minimal macOS-only `trash` custom tool for Pi.

It calls Apple's `/usr/bin/trash` directly and has no runtime dependencies. The tool is intentionally separate from `pi-sandbox-exec` because custom tools do not execute through the overridden `bash` backend.

## Behavior

- moves files/directories to macOS Trash with `/usr/bin/trash -s`
- accepts multiple paths
- only allows targets inside the session workspace
- refuses the workspace root itself
- rejects paths that escape through a symlinked parent directory
- does not expand globs
- does not use a shell

Requires macOS 15 or later, where `/usr/bin/trash` is included by the OS.

## Install

Clone it into Pi's global extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/glyzinie/pi-trash.git ~/.pi/agent/extensions/trash
```

Then run `/reload` in Pi, or restart Pi.

## Tool call

```json
{
  "paths": [
    "src/old.ts",
    "tmp/old-output"
  ]
}
```

The tool appears under **Custom Tools** as `trash`.

## License

MIT © Wis
