# DeepSeek Harness Desktop for Codex

[English](./README.en.md)

这个 fork 让 Codex 通过专属 MCP 插件调用已安装的 DeepSeek Harness 桌面版，在可见的 Web 会话中委派任务，然后独立检查工作区变更。原有 npm runtime 仍然保留。

当前兼容目标是桌面版 `0.2.1-rc.2`，需要 Node.js 22 或更新版本及支持插件的 Codex。桌面版须已配置选中的模型、明确的 `llm-pi-ai` provider、`baseURL` 和 `apiKeyEnv`。仅有 OAuth 登录或动态 JavaScript 模型配置不属于此适配器的支持范围。自动化测试覆盖启动、协议和凭据隔离；安装后仍须单独验证实际模型连接。

## 安装

从本地源码目录安装时，先安装依赖并构建被 git 忽略的 `dist/`：

```powershell
npm ci
npm run check
node .\scripts\configure-local.mjs --dsh-executable 'D:\Apps\DSH\DeepSeek Harness.exe'
codex plugin marketplace add (Get-Location).Path
codex plugin add deepseek-harness@deepseek-harness-desktop
```

也可以从本仓库一次成功的 GitHub Actions 运行中下载自包含插件 artifact，将完整内容解压到固定的本地目录，进入该目录后执行上面的 `configure-local.mjs` 及两条 `codex plugin` 命令。自包含 artifact 已包含运行文件，无需再次执行 `npm ci`。直接添加 GitHub 远端 marketplace 不会自动构建 `dist/`。

安装完成后新建 Codex task。此 fork 的 marketplace 名称是 `deepseek-harness-desktop`，插件 ID 是 `deepseek-harness@deepseek-harness-desktop`，MCP namespace 是 `deepseek-harness-desktop`。如果同时安装了上游插件，可停用旧插件，避免调用错工具。

## 本地桌面版配置

`configure-local.mjs` 默认写入 `~/.deep-seek-harness-mcp/local-runtime.json`，仅保存以下四个路径，不保存 API key：

| 字段 | 用途 |
| --- | --- |
| `dshExecutable` | 桌面版可执行文件的绝对路径 |
| `dshCli` | 桌面版自带 CLI 的绝对路径 |
| `dshHome` | 原桌面版配置目录，默认 `~/.dsh` |
| `desktopProfile` | 原桌面版 profile 文件 |

可用 `--dsh-home` 指定原配置目录，用 `--settings` 指定适配器设置文件。使用自定义设置文件时，还须将其路径通过 `DSH_MCP_LOCAL_SETTINGS` 传给 MCP server。桌面版更新或移动后，应重新运行配置命令。

存在本地设置文件时自动使用 local runtime。`DSH_MCP_RUNTIME=local` 可以明确选择桌面版；`DSH_MCP_RUNTIME=npm` 可以回到原有 npm runtime。此设置不要求修改系统默认 PowerShell。

适配器只读取当前选中 provider/model 的必要配置。原 credential store 保持只读：只解析选中的 credential reference，将对应值通过私有进程管道读入内存，再传给 DSH 子进程环境。store 中该 reference 的值优先于同名启动环境变量；不会复制整个凭据文件，也不会把 key 写入设置文件、模型覆盖文件或 doctor 输出。

Web 服务使用独立目录存放会话、浏览器登录状态及自己的 credential store，不把原桌面版 store 作为可写存储。请勿打印适配器内部 helper 的原始输出或序列化子进程环境，它们包含私有凭据传递数据。

## 验证与使用

完成构建及本地配置后，在普通用户终端的插件目录中运行：

```powershell
node .\scripts\test-local.mjs
```

该脚本通过新 MCP bundle 启动 DSH Web，在独立临时空工作区请求严格回复 `DSH_CONNECTION_OK`，不接触项目文件。它需要实际模型网络访问；沙箱网络限制及 CI 的模拟测试都不能证明真实服务已返回 HTTP 200。

在新 Codex task 中可以这样请求：

> 使用 deepseek-harness-desktop 的 doctor 检查本地配置，然后在空临时工作区发起一次最小模型请求，只回复 DSH_CONNECTION_OK，不使用工具或读写项目文件。不要自动打开浏览器，提供 Web 会话链接和实际执行结果。

doctor 只检查运行时、路径、模型和本地凭据元数据，不发送模型请求。`credentialAvailable: true` 表示找到该 reference 对应的非空本地值，不代表服务器已接受凭据、套餐有权限或网络可用。直接运行 DSH CLI 成功也不能替代通过本插件的验证。

日常任务示例：

> 使用 DeepSeek Harness Desktop 在当前仓库修复这个问题，给我可见会话链接。结束后由 Codex 检查 diff 并执行相关检查。

插件的标准流程是先 doctor，确定明确的任务和工作区，再启动或续接可见会话，等待结果，最后由 Codex 独立审查。新任务默认新建会话；只有同一工作区已完成的会话适合续接。失败、取消、超时或达到限制都不等于任务完成。

| MCP 工具 | 用途 |
| --- | --- |
| `doctor` | 检查本地配置和运行前提 |
| `start_service` | 启动或复用本地 Web 服务 |
| `open_service` | 按用户明确要求打开 Web 页面 |
| `list_services` | 列出托管 Web 服务 |
| `stop_service` | 停止托管 Web 服务 |
| `start_run` | 在可见会话中委派一次任务 |
| `get_run` | 读取运行状态 |
| `wait_run` | 等待状态变化 |
| `cancel_run` | 取消运行 |
| `list_runs` | 列出托管运行 |

## 环境设置

| 环境变量 | 用途 |
| --- | --- |
| `DSH_MCP_RUNTIME` | `local` 或 `npm`；未设置时按本地配置是否存在选择 |
| `DSH_MCP_LOCAL_SETTINGS` | 本地 runtime 设置文件路径 |
| `DSH_MCP_DATA_DIR` | 独立 Web 服务数据目录；默认使用插件数据目录或 `~/.deep-seek-harness-mcp` |
| `DSH_MCP_WORKSPACE_ROOTS` | 限制允许访问的工作区根目录 |
| `DSH_PERMISSION_MODE` | DSH 权限模式，默认 `workspace-write` |
| `DSH_MCP_HARNESS_PACKAGE` | npm runtime 的包覆盖选项 |
| `DSH_MCP_NPX_COMMAND` | npm runtime 的 npx 可执行文件覆盖选项 |

local runtime 直接启动桌面版自带 CLI，只监听 `127.0.0.1` 并传入 `--no-open`。Windows npm runtime 使用 Node 执行 `npx-cli.js`，避免通过 shell 启动 `.cmd` 的兼容问题。

工作区必须是存在的绝对路径，并经过真实路径及允许根目录检查。默认不自动打开浏览器，不自动提高权限；带认证信息的 Web 会话链接应当私密保存。Codex 对结果的独立验证仍然必要，提交、推送、发布或部署需要用户明确要求。

## 更新与卸载

更新源码后重新执行 `npm ci` 和 `npm run check`，或用新 Actions artifact 完整替换本地插件目录，然后更新 marketplace 并在新 task 中使用：

```powershell
codex plugin marketplace upgrade deepseek-harness-desktop
codex plugin add deepseek-harness@deepseek-harness-desktop
```

卸载插件：

```powershell
codex plugin remove deepseek-harness@deepseek-harness-desktop
codex plugin marketplace remove deepseek-harness-desktop
```

许可证：MIT。此 fork 不需要发布上游 npm 包即可使用本地桌面版。
