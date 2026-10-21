/* Runs inside the installed DSH Electron/Node runtime, using its bundled YAML parser. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

try {
  const input = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fs.readFileSync(0, 'utf8');
  const settings = JSON.parse(input.replace(/^\uFEFF/, ''));
  const packageEntry = settings.dshCli.replace(/@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js$/, '@deepseek-ai/dsh-credentials-local/lib/index.js');
  const yaml = createRequire(packageEntry)('yaml');
  function parse(text) {
    const document = yaml.parseDocument(text, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => ({ __dshDynamicConfiguration: true }) }],
    });
    if (document.errors.length) throw Error('Unable to parse local DSH configuration safely.');
    return document.toJS();
  }
  function rejectInlineSecrets(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replace(/[-_]/g, '').toLowerCase();
      if (/^(apikey|accesstoken|refreshtoken|authorization|proxyauthorization|password|secret|token|xapikey|xauthtoken|headers)$/.test(normalized)) {
        throw Error('Inline provider secrets and headers are unsupported; use a DSH credential reference.');
      }
      if (key === '__dshDynamicConfiguration') throw Error('Dynamic model configuration cannot be copied safely.');
      rejectInlineSecrets(item);
    }
  }
  const entries = parse(fs.readFileSync(settings.desktopProfile, 'utf8'));
  if (!Array.isArray(entries)) throw Error('DSH desktop configuration must contain a patch list.');
  const selectedModel = entries.find(item => item.id === 'agent-default-model')?.config;
  if (typeof selectedModel?.provider !== 'string' || typeof selectedModel?.model !== 'string') {
    throw Error('No explicit desktop model selection was found.');
  }
  const provider = entries.find(item => item.id === 'llm-pi-ai')?.config?.providers?.[selectedModel.provider];
  if (!provider) throw Error('The selected model does not have a configured pi-ai provider.');
  const selectedProvider = JSON.parse(JSON.stringify(provider));
  if (Array.isArray(selectedProvider.models)) {
    selectedProvider.models = selectedProvider.models.filter(item => item.id === selectedModel.model);
    if (!selectedProvider.models.length) throw Error('The selected custom model is absent from its provider model list.');
  }
  rejectInlineSecrets(selectedModel);
  rejectInlineSecrets(selectedProvider);
  if (typeof selectedProvider.baseURL !== 'string') throw Error('The selected provider requires an explicit baseURL.');
  const address = new URL(selectedProvider.baseURL);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw Error('The provider URL must be HTTP(S) and must not contain credentials or tokens.');
  }
  const reference = selectedProvider.apiKeyEnv;
  const reservedReferences = new Set(['PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'DSH_CWD', 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED', 'NO_COLOR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'COMSPEC', 'SYSTEMROOT', 'WINDIR']);
  if (typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference) || reservedReferences.has(reference.toUpperCase())) {
    throw Error('The selected provider requires a valid environment credential reference.');
  }
  // Resolve one selected value in memory. Never point the Web credential service at the user's store.
  let credential;
  const credentialFile = path.join(settings.dshHome, '.credentials.yaml');
  if (fs.existsSync(credentialFile)) {
    const stored = parse(fs.readFileSync(credentialFile, 'utf8'));
    const storedValue = stored?.refs?.[reference];
    if (typeof storedValue === 'string' && storedValue.trim()) credential = storedValue.trim();
  }
  if (credential === undefined && process.env[reference]?.trim()) credential = process.env[reference].trim();
  if (credential !== undefined && /[\u0000\r\n]/.test(credential)) throw Error('The selected credential has an invalid environment value.');
  const credentialAvailable = credential !== undefined;
  const privateEnvironment = credentialAvailable ? { [reference]: credential } : {};
  const patch = [
    { id: 'agent-default-model', config: selectedModel },
    { id: 'llm-pi-ai', config: { providers: { [selectedModel.provider]: selectedProvider } } },
    { id: 'credentials', disabled: false, config: { watch: false } },
    { id: 'deepseek-account', disabled: true },
  ];
  console.log(JSON.stringify({ patch, modelProvider: selectedModel.provider, model: selectedModel.model, credentialAvailable, credentialRef: reference, privateEnvironment }));
} catch (error) {
  // YAML parse errors can contain source excerpts; never forward them.
  console.error(error.message);
  process.exitCode = 1;
}
