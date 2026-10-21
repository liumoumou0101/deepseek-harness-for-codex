import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HARNESS_PACKAGE = "@deepseek-ai/dsh@0.1.0-rc.6";
export type HarnessRuntime = "local" | "npm";

/** A shell-free command specification for one local Harness process. */
export interface HarnessCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface HarnessWebCommandInput {
  workspace: string;
  serviceHome: string;
}

interface LocalSettings {
  dshExecutable: string;
  dshCli: string;
  dshHome: string;
  desktopProfile: string;
}

interface LocalModelConfiguration {
  patch: unknown[];
  modelProvider: string;
  model: string;
  credentialAvailable: boolean;
  credentialRef: string;
  /** Private helper pipe data: only merge into the owned DSH child environment. */
  privateEnvironment: Record<string, string>;
}

export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_MCP_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim() || join(homedir(), ".deep-seek-harness-mcp");
}

export function resolveAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DSH_MCP_WORKSPACE_ROOTS ?? "").split(delimiter).map(value => value.trim()).filter(Boolean);
}

/** Local settings are separate from the generated plugin cache and contain paths only. */
export function resolveLocalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_MCP_LOCAL_SETTINGS?.trim() || join(homedir(), ".deep-seek-harness-mcp", "local-runtime.json");
}

export function resolveHarnessRuntime(env: NodeJS.ProcessEnv = process.env): HarnessRuntime {
  const configured = env.DSH_MCP_RUNTIME?.trim().toLowerCase();
  if (configured !== undefined && configured !== "" && configured !== "local" && configured !== "npm") {
    throw new Error("DSH_MCP_RUNTIME must be local or npm.");
  }
  if (configured === "local" || configured === "npm") return configured;
  if (env.DSH_MCP_LOCAL_SETTINGS?.trim() || existsSync(resolveLocalSettingsPath(env))) return "local";
  return "npm";
}

function readLocalSettings(env: NodeJS.ProcessEnv): LocalSettings {
  const settingsPath = resolveLocalSettingsPath(env);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    throw new Error("Cannot read valid local DSH settings; run configure-local or set DSH_MCP_LOCAL_SETTINGS.");
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Cannot read valid local DSH settings; expected a JSON object.');
  const dshExecutable = parsed.dshExecutable;
  if (typeof dshExecutable !== "string" || !isAbsolute(dshExecutable) || !existsSync(dshExecutable)) {
    throw new Error("Local DSH settings require an existing absolute dshExecutable path.");
  }
  const resourceRoots = [join(dirname(dshExecutable), "resources"), resolve(dirname(dshExecutable), "..", "Resources")];
  const resources = resourceRoots.find(candidate => existsSync(join(candidate, "app.asar"))) ?? resourceRoots[0]!;
  const dshCli = parsed.dshCli ?? join(resources, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
  const dshHome = parsed.dshHome ?? join(homedir(), ".dsh");
  const desktopProfile = parsed.desktopProfile ?? (typeof dshHome === "string" ? join(dshHome, "profiles", "desktop", "cordis.patch.yml") : undefined);
  for (const [name, value] of Object.entries({ dshCli, dshHome, desktopProfile })) {
    if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`Local DSH setting ${name} must be an absolute path.`);
  }
  return { dshExecutable, dshCli: dshCli as string, dshHome: dshHome as string, desktopProfile: desktopProfile as string };
}

function readModelConfiguration(env: NodeJS.ProcessEnv): { settings: LocalSettings; model: LocalModelConfiguration } {
  const settings = readLocalSettings(env);
  const probe = spawnSync(settings.dshExecutable, ["--expose-internals", fileURLToPath(new URL("./read-model-config.cjs", import.meta.url))], {
    input: JSON.stringify(settings), env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8", shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 1_048_576,
  });
  if (probe.status !== 0) {
    throw new Error(probe.error?.message || probe.stderr.trim() || "Cannot read the local DSH model configuration.");
  }
  let model: LocalModelConfiguration;
  try { model = JSON.parse(probe.stdout.trim()) as LocalModelConfiguration; } catch {
    throw new Error("The local DSH configuration helper returned invalid metadata.");
  }
  if (!Array.isArray(model.patch) || typeof model.modelProvider !== "string" || typeof model.model !== "string" ||
      typeof model.credentialAvailable !== "boolean" || typeof model.credentialRef !== "string" ||
      model.privateEnvironment === null || typeof model.privateEnvironment !== "object" || Array.isArray(model.privateEnvironment) ||
      Object.entries(model.privateEnvironment).some(([name, value]) => name !== model.credentialRef || typeof value !== "string")) {
    throw new Error("The local DSH configuration helper returned incomplete metadata.");
  }
  return { settings, model };
}

/** Resolve Windows npm shims without cmd.exe, shell:true, or argument concatenation. */
function npxCommand(env: NodeJS.ProcessEnv): { command: string; prefix: string[]; configured: string } {
  const configured = env.DSH_MCP_NPX_COMMAND?.trim() || (process.platform === "win32" ? "npx.cmd" : "npx");
  if (process.platform !== "win32" || !/^npx(?:\.cmd)?$/i.test(basename(configured))) {
    return { command: configured, prefix: [], configured };
  }
  const explicitlyLocated = isAbsolute(configured) || /[\\/]/.test(configured);
  const roots: string[] = [];
  if (explicitlyLocated) {
    if (!existsSync(configured)) throw new Error("The configured npx command does not exist.");
    roots.push(dirname(resolve(configured)), dirname(realpathSync(configured)));
  } else {
    roots.push(dirname(process.execPath));
    for (const entry of (env.PATH ?? env.Path ?? env.path ?? "").split(delimiter)) {
      if (entry.trim()) roots.push(entry.trim());
    }
  }
  for (const root of new Set(roots)) {
    const candidate = join(root, "node_modules", "npm", "bin", "npx-cli.js");
    if (existsSync(candidate)) return { command: process.execPath, prefix: [candidate], configured };
  }
  throw new Error("Cannot locate npm npx-cli.js for the configured Windows npx command.");
}

export function buildHarnessWebCommand(input: HarnessWebCommandInput, env: NodeJS.ProcessEnv = process.env): HarnessCommand {
  const sharedEnv = {
    ...env, DSH_CWD: input.workspace, DSH_HOME: input.serviceHome,
    DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE?.trim() || "workspace-write",
    DSH_TELEMETRY_DISABLED: env.DSH_TELEMETRY_DISABLED?.trim() || "1", NO_COLOR: "1",
  };
  if (resolveHarnessRuntime(env) === "local") {
    const { settings, model } = readModelConfiguration(env);
    mkdirSync(input.serviceHome, { recursive: true });
    const overlay = join(input.serviceHome, "local-model-overlay.yml");
    writeFileSync(overlay, JSON.stringify(model.patch, null, 2), { encoding: "utf8", mode: 0o600 });
    return {
      command: settings.dshExecutable,
      args: ["--expose-internals", settings.dshCli, "--profile", "web", "--patch", overlay, "--no-open", "--host", "127.0.0.1", "--port", "0"],
      cwd: input.workspace, env: { ...sharedEnv, ...model.privateEnvironment, ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const launch = npxCommand(env);
  const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE;
  if (harnessPackage.startsWith("-")) throw new Error("DSH_MCP_HARNESS_PACKAGE must be an npm package specifier, not an option.");
  return {
    command: launch.command,
    args: [...launch.prefix, "--yes", `--package=${harnessPackage}`, "--", "dsh", "web", "--port", "0"],
    cwd: input.workspace, env: { ...sharedEnv, npm_config_yes: "true" },
  };
}

/** Checks local prerequisites without downloading packages or making a model request. */
export function inspectRuntime(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const nodeSupported = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 22;
  const common = {
    ready: false, nodeVersion: process.versions.node, nodeSupported, platform: process.platform, architecture: process.arch,
    dataDirectory: resolveDataDirectory(env), allowedWorkspaceRoots: resolveAllowedRoots(env), surface: "web",
  };
  let runtime: HarnessRuntime;
  try { runtime = resolveHarnessRuntime(env); } catch (error) {
    return { ...common, error: error instanceof Error ? error.message : String(error) };
  }
  if (runtime === "local") {
    try {
      const { settings, model } = readModelConfiguration(env);
      const version = spawnSync(settings.dshExecutable, ["--expose-internals", settings.dshCli, "--version"], {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", shell: false, windowsHide: true, timeout: 15_000,
      });
      return {
        ...common, runtime, harnessSource: "installed-desktop", ready: nodeSupported && version.status === 0,
        dshExecutable: settings.dshExecutable, dshVersion: version.status === 0 ? version.stdout.trim() : null,
        modelProvider: model.modelProvider, model: model.model, credentialRef: model.credentialRef,
        credentialAvailable: model.credentialAvailable, apiKeyInEnvironment: Boolean(env[model.credentialRef]?.trim()),
      };
    } catch (error) {
      return { ...common, runtime, harnessSource: "installed-desktop", error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const launch = npxCommand(env);
    const probe = spawnSync(launch.command, [...launch.prefix, "--version"], {
      env, encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000,
    });
    return {
      ...common, runtime, harnessSource: "npm", ready: nodeSupported && probe.status === 0,
      npxCommand: launch.configured, npxExecutable: launch.command, npxAvailable: probe.status === 0,
      npxVersion: probe.status === 0 ? probe.stdout.trim() : null,
      harnessPackage: env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE,
      apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    };
  } catch (error) {
    return { ...common, runtime, harnessSource: "npm", npxAvailable: false, error: error instanceof Error ? error.message : String(error) };
  }
}
