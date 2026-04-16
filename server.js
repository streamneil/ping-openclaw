/**
 * Openclaw WebSocket 中转代理服务 (Proxy Server)
 *
 * 架构：浏览器 <——WS——> 本服务 <——WS(+Auth)——> Openclaw 底层引擎
 *
 * 职责：
 *   1. 托管前端静态文件 (Express)
 *   2. 向前端暴露 WebSocket 接入点
 *   3. 为每个前端连接以受信任身份连接 Openclaw（Bearer Header + ?token= 双重注入）
 *   4. 自动响应 Openclaw 的 connect.challenge 握手
 *   5. 双向透传消息；Openclaw 未就绪时先缓冲前端消息而不是丢弃
 *   6. 心跳保活 & 状态广播（proxy_status）
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

require('dotenv').config();

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: Number(process.env.PORT) || 8192,
  // 监听地址：默认仅本机回环；在 openclaw 同机部署时这是最安全的默认值。
  // 如果需要从局域网其他设备访问前端，设 HOST=0.0.0.0。
  HOST: process.env.HOST || '127.0.0.1',
  OPENCLAW_WS_URL: process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',
  OPENCLAW_TOKEN: process.env.OPENCLAW_TOKEN || '',
  PUBLIC_DIR: path.join(__dirname, 'public'),
  DEBUG_WS: String(process.env.DEBUG_WS || '').toLowerCase() === 'true',
  // Openclaw 连接握手/等待超时（毫秒）
  UPSTREAM_OPEN_TIMEOUT: 8000,
  // 心跳间隔（毫秒），0 表示关闭
  HEARTBEAT_INTERVAL: 25000,
};

if (!CONFIG.OPENCLAW_TOKEN) {
  console.warn('[Proxy] ⚠ 环境变量 OPENCLAW_TOKEN 为空，鉴权大概率会失败');
}

// ─── HTTP + WS Server ────────────────────────────────────────────────────────
const app = express();
app.use(express.static(CONFIG.PUBLIC_DIR));

// 健康检查端点，便于运维 / 自测脚本使用
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    upstream: CONFIG.OPENCLAW_WS_URL,
    port: CONFIG.PORT,
    clients: wss ? wss.clients.size : 0,
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log('[Proxy] 服务启动中...');
console.log(`[Proxy] 监听地址:   ${CONFIG.HOST}:${CONFIG.PORT}`);
console.log(`[Proxy] 底层引擎:   ${CONFIG.OPENCLAW_WS_URL}`);
console.log(`[Proxy] Token:      ${CONFIG.OPENCLAW_TOKEN ? '******(已注入)' : '(未配置)'}`);
console.log(`[Proxy] 调试报文:   ${CONFIG.DEBUG_WS ? 'ON' : 'OFF'}`);

// ─── 核心：每个前端连接 ──────────────────────────────────────────────────────
wss.on('connection', (frontendSocket, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[Proxy] [${clientId}] 前端已连接`);

  // Openclaw 未就绪前缓冲前端消息（避免首条消息丢失）
  const pendingFromFrontend = [];
  let upstreamReady = false;

  // A. 以 Bearer Header + ?token= 双通道鉴权连接 Openclaw
  const urlWithToken = appendQueryToken(CONFIG.OPENCLAW_WS_URL, CONFIG.OPENCLAW_TOKEN);
  const openclawSocket = new WebSocket(urlWithToken, {
    headers: CONFIG.OPENCLAW_TOKEN
      ? { Authorization: `Bearer ${CONFIG.OPENCLAW_TOKEN}` }
      : {},
    handshakeTimeout: CONFIG.UPSTREAM_OPEN_TIMEOUT,
  });

  // 对前端通告代理状态（不影响业务数据流，前端可选监听）
  notifyProxy(frontendSocket, 'connecting', `connecting to ${CONFIG.OPENCLAW_WS_URL}`);

  // B. Openclaw → 前端
  openclawSocket.on('message', (data) => {
    const raw = data.toString();
    if (CONFIG.DEBUG_WS) console.log(`[${ts()}] [${clientId}] ⇠ OPENCLAW  ${raw}`);

    // 拦截 connect.challenge 握手：代理自行完成，不透传
    try {
      const msg = JSON.parse(raw);
      if (msg?.type === 'event' && msg?.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce;
        console.log(`[Proxy] [${clientId}] challenge → auth (nonce=${nonce})`);
        safeSend(openclawSocket, JSON.stringify({
          type: 'auth',
          payload: { token: CONFIG.OPENCLAW_TOKEN, nonce },
        }));
        return;
      }
    } catch (_) { /* 非 JSON，走正常透传 */ }

    safeSend(frontendSocket, raw);
  });

  // C. 前端 → Openclaw（带 OPEN 前的缓冲）
  frontendSocket.on('message', (data) => {
    const raw = data.toString();
    if (CONFIG.DEBUG_WS) console.log(`[${ts()}] [${clientId}] ⇢ FRONTEND ${raw}`);

    if (openclawSocket.readyState === WebSocket.OPEN) {
      openclawSocket.send(raw);
    } else if (openclawSocket.readyState === WebSocket.CONNECTING) {
      // 尚未就绪，先缓冲；open 事件里一次性发出
      pendingFromFrontend.push(raw);
    } else {
      notifyProxy(frontendSocket, 'error', '底层引擎连接已关闭，消息未发送');
    }
  });

  // D. 就绪与断开
  openclawSocket.on('open', () => {
    upstreamReady = true;
    console.log(`[Proxy] [${clientId}] ✓ 已连接至 Openclaw`);
    notifyProxy(frontendSocket, 'ready', 'upstream connected');

    // 把缓冲的消息一次性发出
    while (pendingFromFrontend.length) {
      safeSend(openclawSocket, pendingFromFrontend.shift());
    }
  });

  openclawSocket.on('error', (err) => {
    console.error(`[Proxy] [${clientId}] Openclaw 连接错误: ${err.message}`);
    notifyProxy(frontendSocket, 'error', `底层引擎连接失败: ${err.message}`);
  });

  openclawSocket.on('close', (code, reason) => {
    const reasonText = reason ? reason.toString() : '';
    console.log(`[Proxy] [${clientId}] Openclaw 断开 code=${code} reason=${reasonText}`);
    notifyProxy(frontendSocket, 'closed', `upstream closed (code=${code})`);
    if (frontendSocket.readyState === WebSocket.OPEN) {
      frontendSocket.close(1001, 'Upstream connection closed');
    }
  });

  frontendSocket.on('close', (code) => {
    console.log(`[Proxy] [${clientId}] 前端断开 code=${code}`);
    if (openclawSocket.readyState !== WebSocket.CLOSED &&
        openclawSocket.readyState !== WebSocket.CLOSING) {
      openclawSocket.close();
    }
  });

  frontendSocket.on('error', (err) => {
    console.error(`[Proxy] [${clientId}] 前端连接错误: ${err.message}`);
    if (openclawSocket.readyState !== WebSocket.CLOSED) openclawSocket.close();
  });

  // E. 心跳保活（双向 ping）
  if (CONFIG.HEARTBEAT_INTERVAL > 0) {
    const hb = setInterval(() => {
      if (frontendSocket.readyState === WebSocket.OPEN) frontendSocket.ping();
      if (openclawSocket.readyState === WebSocket.OPEN) openclawSocket.ping();
    }, CONFIG.HEARTBEAT_INTERVAL);
    const stop = () => clearInterval(hb);
    frontendSocket.once('close', stop);
    openclawSocket.once('close', stop);
  }

  // F. 连接就绪超时 — 如果在限定时间内 open 没触发，显式告知前端
  setTimeout(() => {
    if (!upstreamReady && openclawSocket.readyState === WebSocket.CONNECTING) {
      console.warn(`[Proxy] [${clientId}] 上游连接超时（${CONFIG.UPSTREAM_OPEN_TIMEOUT}ms）`);
      notifyProxy(frontendSocket, 'error', `连接 Openclaw 超时（${CONFIG.UPSTREAM_OPEN_TIMEOUT}ms）`);
      try { openclawSocket.terminate(); } catch (_) {}
    }
  }, CONFIG.UPSTREAM_OPEN_TIMEOUT + 200);
});

// ─── 工具函数 ────────────────────────────────────────────────────────────────
function safeSend(socket, data) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
}

function notifyProxy(socket, state, message) {
  safeSend(socket, JSON.stringify({ type: 'proxy_status', state, message }));
}

function appendQueryToken(wsUrl, token) {
  if (!token) return wsUrl;
  const sep = wsUrl.includes('?') ? '&' : '?';
  return `${wsUrl}${sep}token=${encodeURIComponent(token)}`;
}

function ts() {
  return new Date().toISOString();
}

// ─── 启动 ───────────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  const displayHost = CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST;
  console.log(`[Proxy] ✓ HTTP + WebSocket 服务已启动 → http://${displayHost}:${CONFIG.PORT}`);
  if (CONFIG.HOST === '0.0.0.0') {
    console.log('[Proxy] ⚠ HOST=0.0.0.0 — 局域网内任意设备都能访问，请确保网络可信');
  }
});

process.on('uncaughtException', (err) => console.error('[Proxy] 未捕获的异常:', err));
process.on('unhandledRejection', (r) => console.error('[Proxy] 未处理的 Promise 拒绝:', r));
