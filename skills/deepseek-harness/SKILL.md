---
name: deepseek-harness
description: Use when the user asks Codex to use, show, control, or delegate work to an installed DeepSeek Harness desktop application through its dedicated plugin.
---

# DeepSeek Harness Desktop

Use the `deepseek-harness-desktop` MCP namespace from plugin `deepseek-harness@deepseek-harness-desktop`. The user must be able to watch the same Web session that Codex controls. Codex remains responsible for the task outcome and must inspect the changed files and run appropriate verification itself.

The local desktop compatibility target is `0.2.1-rc.2`, with Node.js 22 or later. Local settings at `~/.deep-seek-harness-mcp/local-runtime.json` select the installed desktop runtime automatically; `DSH_MCP_RUNTIME=npm` selects the original npm runtime. Configure paths with `node scripts/configure-local.mjs --dsh-executable 'D:\Apps\DSH\DeepSeek Harness.exe'`, optionally `--dsh-home` or `--settings`. These settings contain paths, not keys. Source installations require `npm ci` and `npm run check` before adding the local marketplace. A self-contained GitHub Actions artifact can instead be extracted and added locally. A remote marketplace installation does not build ignored `dist/` files. Start a new Codex task after installation. Skill availability alone does not prove that the MCP server is running. If the `deepseek-harness-desktop` tools are missing, report that the plugin is not ready, check installation or startup errors, and recheck in a new task; do not present an old namespace or direct CLI test as this plugin succeeding.

## Workflow

1. Call `doctor` before the first run in a task. Explain any failed prerequisite. doctor checks runtime, paths, selected provider/model, and local credential metadata without a model request. `credentialAvailable` means a nonempty local referenced value was found; it does not establish network access, authentication, or subscription permissions. Use the configured provider/model. If credentials are missing, direct the user to their existing DSH credential configuration or MCP environment; do not ask them to paste keys into chat. A successful direct CLI call does not prove that this plugin works.
2. Inspect the target repository enough to write a concrete delegation prompt. Include the requested outcome, relevant repository instructions, scope limits, and acceptance checks. Do not include credentials.
3. Decide whether the attempt needs a new Harness session or should continue a completed one. Omit `sessionId` for independent work or a clean retry. Pass the earlier run's `sessionId` for a direct follow-up or correction that benefits from the existing conversation. Never reuse a running session or a session from another workspace.
4. Call `start_run` exactly once for that attempt with `openBrowser: false` and the chosen `sessionId`, if any. It starts or reuses the Web service and submits the task without opening a browser. For a connection-only test, use an empty temporary workspace, request a minimal reply, and prohibit tools and project file access.
5. Show the returned `webUrl` as a clickable Markdown link so the user can open the live page when they choose. State whether `sessionReused` is true. Do not call `open_service` unless the user explicitly asks Codex to open the page. Keep authenticated session links out of commits and shared logs.
6. Call `wait_run` with a timeout of at most 30 seconds until the run is `succeeded`, `failed`, or `cancelled`. The browser and MCP observe the same session ID and history. Report failure, cancellation, timeout, or limits as such. A running service, a successful doctor, or a session title alone is not a successful model request.
7. Treat the Harness response as a handoff report, not proof. Inspect the actual workspace diff, preserve unrelated user changes, and run the smallest checks that cover the change.
8. If review finds a concrete defect, choose whether to continue the completed session for context or start a clean correction session, state the defect and failed check precisely, and review the correction again.
9. Use `cancel_run` to cancel an unsafe or obsolete turn while leaving the Web page available. Use `stop_service` only when the local server is no longer needed.

## Safety

- Harness Web starts as a loopback-only local child process and receives access to the requested workspace. Use an existing absolute workspace path and do not pass a broader directory than needed. Permitted-root checks apply to resolved real paths.
- The default permission mode is `workspace-write`. Do not switch to `danger-full-access` unless the user explicitly authorizes that broader access.
- The original desktop credential store is read-only. The adapter resolves only the selected reference and transfers its value through a private process pipe and child environment. Do not print the internal helper output or private environment, copy the whole credential file, or use the original store as writable Web storage. Web sessions, browser login state, and the Web credential store belong in the separate service directory.
- Do not ask Harness to commit, push, publish, deploy, or contact external systems unless the user explicitly requested that action.
