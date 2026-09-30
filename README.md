# pi-trash

Minimal macOS-only `trash` custom tool for Pi.

It calls Apple's `/usr/bin/trash` directly and has no additional runtime dependencies. Custom tools do not execute through an overridden `bash` backend.

## Behavior

- moves files/directories to macOS Trash with `/usr/bin/trash -s`
- accepts up to 100 paths and validates the whole batch before moving anything
- removes duplicate targets and paths covered by a selected parent directory
- only allows targets inside the session workspace, including absolute workspace aliases
- refuses the workspace root itself
- rejects paths that escape through a symlinked parent directory, but moves final symlinks themselves
- does not expand globs or use a shell
- previews up to 10 escaped paths and retains full target paths in result details
- warns that partial moves may have occurred if the command fails or is aborted

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

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests use temporary directories and mock the Trash command; they do not move files to the system Trash.

## License

MIT © Wis
