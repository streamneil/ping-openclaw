# Ping Openclaw

一个极简的 Web 聊天控制台，通过本地代理连接到 [OpenClaw](https://openclaw.ai) Agent 引擎。

```
浏览器 (public/index.html)
    │ WebSocket  ws://localhost:8192
    ▼
Node 代理 (server.js) — 负责 connect 握手 + operator 鉴权
    │ WebSocket  ws://<openclaw-host>:18789
    ▼
OpenClaw Gateway
```

实现参考 [openclaw-studio](https://github.com/grp06/openclaw-studio) 的 `OpenClawGatewayAdapter`：先以 `backend-local` profile 发起 `connect`，若 token 权限不足会自动回落到 `legacy-control-ui`（webchat）profile。

## 前置条件

- Node.js ≥ 18
- 本机或局域网里跑着一个 OpenClaw Gateway（默认 `ws://127.0.0.1:18789`）
- 一个可用的 OpenClaw Token

## 启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境
cp .env.example .env
# 编辑 .env，至少填 OPENCLAW_TOKEN

# 3. 启动（文件改动自动重启）
npm run dev
# 或
npm start
```

浏览器打开 <http://localhost:8192>，看到顶部状态变 **ONLINE** 即可开始聊天。回车发送，Shift+Enter 换行。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENCLAW_TOKEN` | — | **必填**。OpenClaw 的 Bearer Token |
| `OPENCLAW_WS_URL` | `ws://127.0.0.1:18789` | OpenClaw Gateway 的 WebSocket 地址 |
| `PORT` | `8192` | 本服务监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。改 `0.0.0.0` 开放给局域网 |
| `DEBUG_WS` | `false` | `true` 时打印双向 WS 帧，排查协议用 |

## 健康检查

```bash
curl http://localhost:8192/healthz
```

返回当前 adapter 状态 (`connected` / `connecting` / `error`) 和上游地址。

## 文件结构

```
ping-openclaw/
├── server.js           # Gateway adapter + WS 桥接
├── public/index.html   # 前端控制台
├── probe-auth.js       # 鉴权协议嗅探工具（保留仅供诊断）
├── ping.js             # 上游连通性探测工具
└── .env.example
```
