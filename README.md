# Ping Openclaw — WebSocket 中转代理服务

为 Openclaw AI Agent 引擎提供一个安全的 WebSocket 代理层，并内置极简的前端测试控制台。

## 架构

```
浏览器 (index.html)
    │  WebSocket  ws://localhost:8192
    ▼
Node.js 代理服务 (server.js)          ← 注入 Authorization: Bearer <TOKEN>
    │  WebSocket  ws://<OPENCLAW_HOST>:18789
    ▼
Openclaw 底层引擎
```

前端对底层 Openclaw **完全无感知**，所有鉴权由代理层统一处理。

---

## 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量（推荐）

复制示例文件并填入真实值：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
OPENCLAW_TOKEN=your_real_token_here
OPENCLAW_WS_URL=ws://your-server-ip:18789
```

> 也可以直接修改 `server.js` 中的 `CONFIG` 对象，详见下方[配置说明](#配置说明)。

### 3. 启动服务

```bash
# 生产启动
npm start

# 开发模式（文件变更自动重启，需 Node.js >= 18）
npm run dev
```

服务启动后，终端输出：

```
[Proxy] 服务启动中...
[Proxy] 底层引擎地址: ws://127.0.0.1:18789
[Proxy] ✓ HTTP + WebSocket 服务已启动 → http://localhost:8192
```

打开浏览器访问：**http://localhost:8192**

---

## 配置说明

所有配置集中在 `server.js` 顶部的 `CONFIG` 对象：

```js
const CONFIG = {
  PORT: 8192,                                         // 本服务监听端口
  OPENCLAW_WS_URL: 'ws://127.0.0.1:18789',            // Openclaw 引擎地址
  OPENCLAW_TOKEN: process.env.OPENCLAW_TOKEN || '…',  // 鉴权 Token
  PUBLIC_DIR: path.join(__dirname, 'public'),          // 静态文件目录
};
```

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 代理服务 HTTP/WS 监听端口 | `8192` |
| `OPENCLAW_WS_URL` | Openclaw 底层引擎的 WebSocket 地址 | `ws://127.0.0.1:18789` |
| `OPENCLAW_TOKEN` | 注入到 Openclaw 连接头的 Bearer Token | 优先读取环境变量 `OPENCLAW_TOKEN` |
| `PUBLIC_DIR` | 前端静态文件目录 | `./public` |

### 通过环境变量覆盖（推荐）

```bash
OPENCLAW_TOKEN=abc123 OPENCLAW_WS_URL=ws://192.168.1.10:18789 npm start
```

---

## 项目结构

```
ping-openclaw/
├── server.js           # 代理服务（Express + WebSocket）
├── package.json        # 依赖声明
├── .env.example        # 环境变量示例
└── public/
    └── index.html      # 前端测试控制台（纯 HTML，无框架依赖）
```

---

## 前端控制台使用

- 在底部输入框中输入任意文本或 JSON 指令
- **Enter** 发送，**Shift + Enter** 换行
- 返回的 JSON 数据会自动格式化展示，便于调试
- 顶部状态指示灯：🟢 已连接 / 🔴 已断开（断线后自动重连）

---

## 异常处理

| 场景 | 行为 |
|---|---|
| Openclaw 引擎未启动 | 前端气泡显示错误提示，不影响代理进程 |
| Openclaw 连接中断 | 自动关闭对应前端连接，释放资源 |
| 前端页面关闭 | 自动断开对应的 Openclaw 连接，无资源泄漏 |
| 未捕获的异常 | 进程级 `uncaughtException` 兜底，防止服务 Crash |

---

## 依赖

| 包 | 用途 |
|---|---|
| [express](https://expressjs.com/) | HTTP 服务 & 静态文件托管 |
| [ws](https://github.com/websockets/ws) | WebSocket 服务端 & 客户端 |
