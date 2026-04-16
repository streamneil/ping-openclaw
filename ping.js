/**
 * Openclaw 连通性自测脚本
 *
 * 跳过前端 / Express，直接从 Node 侧连接 Openclaw 底层 WebSocket，
 * 打印完整握手 & 首批消息，用于判断：
 *   - 目标主机 / 端口是否可达
 *   - TLS / 鉴权是否正确
 *   - 对端是否走 connect.challenge 协议
 *
 * 用法：
 *   node ping.js                       # 使用 .env 中的配置
 *   node ping.js ws://1.2.3.4:18789    # 覆盖 URL
 */

require('dotenv').config();
const WebSocket = require('ws');

const URL = process.argv[2] || process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789';
const TOKEN = process.env.OPENCLAW_TOKEN || '';
const TIMEOUT = 8000;

const urlWithToken = TOKEN
  ? `${URL}${URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`
  : URL;

console.log(`[ping] 目标: ${URL}`);
console.log(`[ping] Token: ${TOKEN ? '******' : '(未配置)'}`);
console.log(`[ping] 正在连接...`);

const ws = new WebSocket(urlWithToken, {
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  handshakeTimeout: TIMEOUT,
});

const timer = setTimeout(() => {
  console.error(`[ping] ✗ ${TIMEOUT}ms 内未完成握手，超时退出`);
  try { ws.terminate(); } catch (_) {}
  process.exit(2);
}, TIMEOUT + 500);

ws.on('open', () => {
  clearTimeout(timer);
  console.log('[ping] ✓ WS 已打开（握手成功）');
  console.log('[ping] 等待 8s 接收 Openclaw 的初始消息，然后退出...');
  setTimeout(() => {
    console.log('[ping] 未发送业务消息，主动关闭连接');
    ws.close();
  }, 8000);
});

ws.on('message', (data) => {
  const raw = data.toString();
  console.log(`[ping] ⇠ ${raw}`);

  // 自动响应 connect.challenge（跟 server.js 保持一致）
  try {
    const msg = JSON.parse(raw);
    if (msg?.type === 'event' && msg?.event === 'connect.challenge') {
      const nonce = msg.payload?.nonce;
      const reply = JSON.stringify({ type: 'auth', payload: { token: TOKEN, nonce } });
      console.log(`[ping] ⇢ auth (nonce=${nonce})`);
      ws.send(reply);
    }
  } catch (_) { /* 非 JSON */ }
});

ws.on('error', (err) => {
  clearTimeout(timer);
  console.error(`[ping] ✗ 错误: ${err.message}`);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  clearTimeout(timer);
  console.log(`[ping] 连接关闭 code=${code} reason=${reason?.toString() || ''}`);
  process.exit(0);
});
