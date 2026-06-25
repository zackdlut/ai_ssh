# AI Terminal — 智能终端

一个 MobaXterm 风格的多 tab SSH 终端，内置 AI Copilot 侧边栏。融合了两种思路：

- **Edge Copilot 侧边栏**：可折叠的 AI 聊天面板，能感知当前终端的最近输出与主机上下文。
- **kubectl-ai**：用自然语言描述意图，AI 生成可执行的 shell 命令，确认后一键注入当前终端执行。

## 技术栈

- Electron + Vite + React + TypeScript（electron-vite）
- 终端：`@xterm/xterm` + `addon-fit` + `addon-web-links`
- SSH：主进程 `ssh2`（交互式 shell channel）
- AI：`openai` SDK，兼容任何 OpenAI 风格 `/chat/completions` 端点（OpenAI / DeepSeek / 本地 vLLM、Ollama 等）
- 状态：`zustand`；本地持久化：`electron-store`

## 安装与运行

```bash
npm install
npm run dev      # 开发模式（热更新）
npm run build    # 生产构建，产物在 out/
npm run typecheck
```

> Electron 二进制下载较慢时，可使用镜像：
> `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install`

## 使用

1. 启动后在弹出的对话框中填写 host / port / username，选择密码或私钥登录，点 **Connect**。
   - 私钥栏可填**文件路径**（如 `~/.ssh/id_ed25519`）或直接粘贴**私钥内容**。
   - 勾选 “Save this connection locally” 可保存连接，下次快速载入。
2. 顶部 tab 栏支持多会话：`+` 新建连接，`×` 关闭，状态点显示连接状态。
3. 右侧 **AI Copilot** 面板（顶栏按钮可开关）：
   - 输入自然语言，例如「查看占用 8080 端口的进程」「show disk usage by directory」。
   - AI 回答中的命令会渲染成**命令卡片**，可 **Run / Edit / Copy**。
   - 点 **Run** 会把命令注入当前活动终端执行；命中危险模式（`rm -rf`、`mkfs`、`dd` 等）会标红并二次确认。
   - 面板会自动附带当前终端最近 ~40 行输出与主机信息作为上下文。
4. 顶栏 **Settings** 配置 AI 的 `baseURL` / `apiKey` / `model`（仅保存在本地，仅主进程使用）。

## 架构

- **主进程** `src/main/`：窗口、SSH 连接池（`ssh/manager.ts`）、AI 流式调用（`ai/provider.ts`）、配置存储（`config/store.ts`）、IPC（`ipc.ts`）。API Key 只存在主进程，不下发渲染进程。
- **Preload** `src/preload/`：通过 `contextBridge` 暴露受限的 `window.api`（`ssh.*` / `ai.*` / `config.*`），开启 `contextIsolation`。
- **渲染进程** `src/renderer/`：三栏布局（tab 栏 + 终端区 + AI 侧边栏）。
- **共享类型** `src/shared/types.ts`。

## 环境注意事项

- **WSL2 / 无头环境**：已在主进程调用 `app.disableHardwareAcceleration()` 以规避 GPU 进程崩溃。
- 若环境中设置了 `ELECTRON_RUN_AS_NODE=1`（部分远程/容器环境会注入），Electron 会以纯 Node 模式运行导致 `app` 为 undefined。运行前请确保未设置该变量：`env -u ELECTRON_RUN_AS_NODE npm run dev`。

## 后续可扩展

连接分组/书签、会话历史持久化、选中输出做解释、SFTP、端口转发、多窗口等。
