/**
 * Openclaw WebSocket 中转代理服务 (Proxy Server)
 *
 * 架构：前端 <——WS——> 本服务 <——WS+Auth——> Openclaw 底层引擎
 *
 * 职责：
 *   1. 托管前端静态文件 (Express)
 *   2. 向前端暴露 WebSocket 接入点
 *   3. 为每个前端连接，以受信任身份连接到底层 Openclaw 引擎（注入 Bearer Token）
 *   4. 双向透传消息，对前端屏蔽底层细节
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// 加载 .env 文件中的环境变量（文件不存在时静默跳过）
require('dotenv').config();

// ─── 配置区 ────────────────────────────────────────────────────────────────────
const CONFIG = {
  // 本服务监听端口
  PORT: 8192,

  // 底层 Openclaw 引擎地址（优先读取 .env 中的 OPENCLAW_WS_URL）
  OPENCLAW_WS_URL: process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',

  // 注入到 Openclaw 连接的鉴权 Token（优先读取 .env 中的 OPENCLAW_TOKEN）
  OPENCLAW_TOKEN: process.env.OPENCLAW_TOKEN || 'YOUR_SECRET_TOKEN_HERE',

  // 静态文件目录
  PUBLIC_DIR: path.join(__dirname, 'public'),
};
// ──────────────────────────────────────────────────────────────────────────────

// 1. 创建 Express 应用，托管静态文件
const app = express();
app.use(express.static(CONFIG.PUBLIC_DIR));

// 2. 创建 HTTP Server（WebSocket Server 将附加在此之上）
const server = http.createServer(app);

// 3. 在同一个 HTTP Server 上启动 WebSocket Server
const wss = new WebSocket.Server({ server });

console.log(`[Proxy] 服务启动中...`);
console.log(`[Proxy] 底层引擎地址: ${CONFIG.OPENCLAW_WS_URL}`);

// ─── 核心：处理每个前端客户端的连接 ───────────────────────────────────────────
wss.on('connection', (frontendSocket, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[Proxy] 前端已连接 [${clientId}]`);

  // ── 步骤 A：立即向底层 Openclaw 发起连接，Token 通过 URL query string 传递 ────
  const openclawUrl = `${CONFIG.OPENCLAW_WS_URL}?token=${encodeURIComponent(CONFIG.OPENCLAW_TOKEN)}`;
  const openclawSocket = new WebSocket(openclawUrl);

  // ── 步骤 B：Openclaw → 前端 的消息透传管道 ───────────────────────────────────
  openclawSocket.on('message', (data) => {
    const raw = data.toString();

    // 打印 Openclaw 返回的所有原始消息（调试用）
    console.log(`[Proxy] [${clientId}] Openclaw RAW →`, raw);

    // 拦截 connect.challenge：由代理自动完成鉴权握手，不透传给前端
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce;
        const authMsg = JSON.stringify({
          type: 'auth',
          payload: {
            token: CONFIG.OPENCLAW_TOKEN,
            nonce,
          },
        });
        console.log(`[Proxy] [${clientId}] 收到 challenge，自动回复 auth (nonce=${nonce})`);
        console.log(`[Proxy] [${clientId}] 发送 auth →`, authMsg);
        openclawSocket.send(authMsg);
        return; // 不向前端转发此握手消息
      }
    } catch (_) { /* 非 JSON，走正常透传 */ }

    // 其余消息正常转发给前端
    if (frontendSocket.readyState === WebSocket.OPEN) {
      frontendSocket.send(raw);
    }
  });

  // ── 步骤 C：前端 → Openclaw 的消息透传管道 ───────────────────────────────────
  frontendSocket.on('message', (data) => {
    // 仅在 Openclaw 连接已就绪时才转发
    if (openclawSocket.readyState === WebSocket.OPEN) {
      openclawSocket.send(data.toString());
    } else {
      // Openclaw 尚未就绪，向前端反馈错误
      console.warn(`[Proxy] [${clientId}] Openclaw 未就绪，消息丢弃`);
      safeSend(frontendSocket, JSON.stringify({
        type: 'proxy_error',
        message: '底层引擎连接尚未建立，请稍后重试',
      }));
    }
  });

  // ── 步骤 D：异常与断开处理 ────────────────────────────────────────────────────

  // Openclaw 连接成功
  openclawSocket.on('open', () => {
    console.log(`[Proxy] [${clientId}] 已连接至 Openclaw`);
  });

  // Openclaw 连接发生错误（网络抖动、服务未启动等）
  openclawSocket.on('error', (err) => {
    console.error(`[Proxy] [${clientId}] Openclaw 连接错误:`, err.message);
    safeSend(frontendSocket, JSON.stringify({
      type: 'proxy_error',
      message: `底层引擎连接失败: ${err.message}`,
    }));
  });

  // Openclaw 连接断开 → 同步关闭前端连接
  openclawSocket.on('close', (code, reason) => {
    console.log(`[Proxy] [${clientId}] Openclaw 断开 (code=${code})`);
    if (frontendSocket.readyState === WebSocket.OPEN) {
      frontendSocket.close(1001, 'Upstream connection closed');
    }
  });

  // 前端连接断开 → 同步关闭 Openclaw 连接（释放资源）
  frontendSocket.on('close', (code) => {
    console.log(`[Proxy] [${clientId}] 前端断开 (code=${code})`);
    if (openclawSocket.readyState !== WebSocket.CLOSED) {
      openclawSocket.close();
    }
  });

  // 前端连接发生错误
  frontendSocket.on('error', (err) => {
    console.error(`[Proxy] [${clientId}] 前端连接错误:`, err.message);
    if (openclawSocket.readyState !== WebSocket.CLOSED) {
      openclawSocket.close();
    }
  });
});

// ─── 工具函数：安全发送（防止向已关闭的 socket 写入造成 crash）─────────────────
function safeSend(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}

// ─── 启动 HTTP + WS Server ────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log(`[Proxy] ✓ HTTP + WebSocket 服务已启动 → http://localhost:${CONFIG.PORT}`);
});

// 捕获全局未处理异常，防止进程意外退出
process.on('uncaughtException', (err) => {
  console.error('[Proxy] 未捕获的异常:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Proxy] 未处理的 Promise 拒绝:', reason);
});
