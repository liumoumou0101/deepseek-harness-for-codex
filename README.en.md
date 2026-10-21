# DeepSeek Harness Desktop for Codex

[简体中文](./README.md)

This fork lets Codex use an installed DeepSeek Harness desktop application through a dedicated MCP plugin, delegate tasks in a visible Web session, and independently review the resulting workspace changes. The original npm runtime remains available.

The desktop compatibility target is `0.2.1-rc.2`. Node.js 22 or later and a Codex version with plugin support are required. Configure the selected model in the desktop application with an explicit `llm-pi-ai` provider, `baseURL`, and `apiKeyEnv`. OAuth-only authentication and dynamic JavaScript model configuration are outside this adapter's scope. Automated tests cover startup, protocol behavior, and credential isolation; an actual model connection must still be verified after installation.

## Installation

When installing from a local source checkout, install dependencies and build the git-ignored `dist/` first:

```powershell
npm ci
npm run check
node .\scripts\configure-local.mjs --dsh-executable 'D:\Apps\DSH\DeepSeek Harness.exe'
codex plugin marketplace add (Get-Location).Path
codex plugin add deepseek-harness@deepseek-harness-desktop
```

Alternatively, download the self-contained plugin artifact from a successful GitHub Actions run in this repository, extract its complete contents to a stable local directory, and run the `configure-local.mjs` and two `codex plugin` commands there. The self-contained artifact includes runtime files and does not require another `npm ci`. Adding the remote GitHub marketplace directly does not build `dist/` automatically.

Start a new Codex task after installation. This fork uses marketplace `deepseek-harness-desktop`, plugin ID `deepseek-harness@deepseek-harness-desktop`, and MCP namespace `deepseek-harness-desktop`. If the upstream plugin is also installed, you can disable it to avoid selecting the wrong tools.

## Local desktop configuration

`configure-local.mjs` writes `~/.deep-seek-harness-mcp/local-runtime.json` by default. It contains these four paths, with no API key:

| Field | Purpose |
| --- | --- |
| `dshExecutable` | Absolute path to the desktop executable |
| `dshCli` | Absolute path to the CLI bundled with the desktop application |
| `dshHome` | Original desktop configuration directory; defaults to `~/.dsh` |
| `desktopProfile` | Original desktop profile file |

Use `--dsh-home` to select the original configuration directory and `--settings` to select an adapter settings file. For a custom settings file, also pass its path to the MCP server through `DSH_MCP_LOCAL_SETTINGS`. Run configuration again after moving or updating the desktop application.

An existing local settings file selects the local runtime automatically. Set `DSH_MCP_RUNTIME=local` to select it explicitly, or `DSH_MCP_RUNTIME=npm` to restore the original npm runtime. This does not require changing the system's default PowerShell.

The adapter reads only the necessary configuration for the selected provider and model. The original credential store is read-only: the helper resolves the selected credential reference, sends its value over a private process pipe into memory, and passes it to the DSH child environment. The stored value takes precedence over the same launch environment variable. The adapter does not copy the whole credential file or write the key to settings, model overlays, or doctor output.

The Web service stores its sessions, browser login state, and its own credential store in a separate directory. It does not use the original desktop store as writable storage. Do not print the internal helper's raw output or serialize the child environment; these contain private credential transfer data.

## Verification and use

After building and configuring the local runtime, run this from the plugin directory in a normal user terminal:

```powershell
node .\scripts\test-local.mjs
```

The script uses the new MCP bundle to start DSH Web and requests an exact `DSH_CONNECTION_OK` reply in a separate empty temporary workspace, without touching project files. It requires actual model network access. Sandbox network restrictions and simulated CI tests cannot establish a real HTTP 200 response from the model service.

In a new Codex task, you can ask:

> Use deepseek-harness-desktop doctor to check local configuration, then make one minimal model request in an empty temporary workspace. Reply only DSH_CONNECTION_OK, use no tools, and do not read or write project files. Do not open a browser automatically. Provide the Web session link and actual execution result.

doctor checks runtime, paths, model configuration, and local credential metadata without making a model request. `credentialAvailable: true` means a nonempty local value was found for the reference. It does not prove server authentication, subscription permissions, or network access. A successful direct DSH CLI call also does not replace verification through this plugin.

For a normal task:

> Use DeepSeek Harness Desktop to fix this issue in the current repository and give me the visible session link. When it finishes, have Codex review the diff and run the relevant checks.

The standard workflow checks doctor, defines a scoped task and workspace, starts or continues a visible session, waits for its result, and then has Codex independently review it. New tasks start new sessions by default. Only a completed session in the same workspace is suitable for continuation. Failure, cancellation, timeout, or reaching a limit does not mean the task succeeded.

| MCP tool | Purpose |
| --- | --- |
| `doctor` | Check local configuration and prerequisites |
| `start_service` | Start or reuse a local Web service |
| `open_service` | Open the Web page at the user's explicit request |
| `list_services` | List managed Web services |
| `stop_service` | Stop a managed Web service |
| `start_run` | Delegate one task in a visible session |
| `get_run` | Read run status |
| `wait_run` | Wait for a status change |
| `cancel_run` | Cancel a run |
| `list_runs` | List managed runs |

## Environment settings

| Variable | Purpose |
| --- | --- |
| `DSH_MCP_RUNTIME` | `local` or `npm`; otherwise selected by whether local settings exist |
| `DSH_MCP_LOCAL_SETTINGS` | Local runtime settings file path |
| `DSH_MCP_DATA_DIR` | Separate Web service data directory; defaults to the plugin data directory or `~/.deep-seek-harness-mcp` |
| `DSH_MCP_WORKSPACE_ROOTS` | Restrict permitted workspace roots |
| `DSH_PERMISSION_MODE` | DSH permission mode; defaults to `workspace-write` |
| `DSH_MCP_HARNESS_PACKAGE` | Override the package used by the npm runtime |
| `DSH_MCP_NPX_COMMAND` | Override the npx executable used by the npm runtime |

The local runtime starts the bundled CLI directly, binds to `127.0.0.1`, and passes `--no-open`. On Windows, the npm runtime invokes `npx-cli.js` through Node to avoid shell-free `.cmd` startup incompatibilities.

Workspaces must be existing absolute paths and pass real-path and permitted-root checks. Browsers are not opened automatically and permissions are not raised automatically. Keep authenticated Web session links private. Codex must still independently verify the result. Commits, pushes, publication, and deployment require an explicit user request.

## Updates and removal

After updating source, run `npm ci` and `npm run check` again, or replace the entire local plugin directory with a new Actions artifact. Then refresh the marketplace and use a new task:

```powershell
codex plugin marketplace upgrade deepseek-harness-desktop
codex plugin add deepseek-harness@deepseek-harness-desktop
```

To remove the plugin:

```powershell
codex plugin remove deepseek-harness@deepseek-harness-desktop
codex plugin marketplace remove deepseek-harness-desktop
```

License: MIT. Using this fork's local desktop runtime does not require publishing an upstream npm package.
