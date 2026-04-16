/**
 * Openclaw 鉴权协议嗅探器
 *
 * 现象：我们回 {type:"auth", payload:{token,nonce}} 后 openclaw 回
 *       code=1008 "invalid request frame"，说明帧结构不符合它的预期。
 *
 * 本脚本依次尝试多种候选格式。只要某次 open → challenge → reply 之后
 * **不是** 1008 立即关闭，就认为该格式正确（具体协议见服务端实现）。
 *
 * 用法：node probe-auth.js
 */

require('dotenv').config();
const WebSocket = require('ws');

const URL = process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789';
const TOKEN = process.env.OPENCLAW_TOKEN || '';

const urlWithToken = TOKEN
  ? `${URL}${URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`
  : URL;

// 候选鉴权帧构造器（拿到 nonce 后生成字符串）
const CANDIDATES = [
  // 现在代理使用的格式（已知失败，留作对照基线）
  {
    name: 'A-baseline',
    build: (nonce) => JSON.stringify({ type: 'auth', payload: { token: TOKEN, nonce } }),
  },
  // event 风格（对称于 type=event 的 challenge）
  {
    name: 'B-event-auth',
    build: (nonce) => JSON.stringify({ type: 'event', event: 'auth', payload: { token: TOKEN, nonce } }),
  },
  // connect.auth 命名（与 connect.challenge 对称）
  {
    name: 'C-event-connect.auth',
    build: (nonce) => JSON.stringify({ type: 'event', event: 'connect.auth', payload: { token: TOKEN, nonce } }),
  },
  {
    name: 'D-event-connect.response',
    build: (nonce) => JSON.stringify({ type: 'event', event: 'connect.response', payload: { token: TOKEN, nonce } }),
  },
  // 常见请求/响应风格（type=request/response + method 名）
  {
    name: 'E-request-auth',
    build: (nonce) => JSON.stringify({ type: 'request', method: 'auth', payload: { token: TOKEN, nonce } }),
  },
  {
    name: 'F-response-challenge',
    build: (nonce) => JSON.stringify({ type: 'response', event: 'connect.challenge', payload: { token: TOKEN, nonce } }),
  },
  // payload 字段改名为 answer（应答语义）
  {
    name: 'G-event-auth-answer',
    build: (nonce) => JSON.stringify({ type: 'event', event: 'auth', payload: { answer: TOKEN, nonce } }),
  },
  // challenge 的纯回显（某些实现只需要 echo nonce）
  {
    name: 'H-event-echo-nonce',
    build: (nonce) => JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce } }),
  },
  // Bearer 语义
  {
    name: 'I-event-authorize-bearer',
    build: (nonce) => JSON.stringify({ type: 'event', event: 'authorize', payload: { authorization: `Bearer ${TOKEN}`, nonce } }),
  },
];

async function probeOne(cand) {
  return new Promise((resolve) => {
    const ws = new WebSocket(urlWithToken, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      handshakeTimeout: 5000,
    });
    const trail = [];
    let sent = false;
    const done = (result) => {
      try { ws.removeAllListeners(); ws.terminate(); } catch (_) {}
      resolve({ name: cand.name, ...result, trail });
    };
    const killer = setTimeout(() => done({ verdict: 'TIMEOUT', note: '发送后 3.5s 未关闭 — 很可能是对的格式' }), 3500);

    ws.on('open', () => trail.push('open'));
    ws.on('message', (buf) => {
      const raw = buf.toString();
      trail.push(`⇠ ${raw.slice(0, 160)}`);
      try {
        const m = JSON.parse(raw);
        if (!sent && m?.type === 'event' && m?.event === 'connect.challenge') {
          const nonce = m.payload?.nonce;
          const reply = cand.build(nonce);
          trail.push(`⇢ ${reply.slice(0, 160)}`);
          ws.send(reply);
          sent = true;
        }
      } catch (_) { /* ignore */ }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(killer);
      const r = reason?.toString() || '';
      const isInvalidFrame = code === 1008 && /invalid request frame/i.test(r);
      done({
        verdict: isInvalidFrame ? 'REJECTED' : `CLOSED ${code}`,
        note: r,
      });
    });
    ws.on('error', (err) => {
      clearTimeout(killer);
      done({ verdict: 'ERROR', note: err.message });
    });
  });
}

(async () => {
  console.log(`[probe] 目标: ${URL}`);
  console.log(`[probe] Token: ${TOKEN ? '******' : '(未配置)'}`);
  console.log(`[probe] 将依次尝试 ${CANDIDATES.length} 种候选格式\n`);

  const survivors = [];
  for (const c of CANDIDATES) {
    process.stdout.write(`[${c.name}] ...`);
    const r = await probeOne(c);
    const tag = r.verdict === 'REJECTED' ? '✗ REJECTED (1008)'
              : r.verdict === 'TIMEOUT'  ? '✓ 存活（疑似正确格式）'
              : `? ${r.verdict}`;
    console.log(` ${tag}  ${r.note ? '— ' + r.note : ''}`);
    r.trail.forEach((line) => console.log(`    ${line}`));
    if (r.verdict === 'TIMEOUT' || (r.verdict.startsWith('CLOSED') && r.verdict !== 'CLOSED 1008')) {
      survivors.push(r);
    }
    console.log('');
  }

  console.log('══════════════════════════════════════');
  if (survivors.length === 0) {
    console.log('所有候选均被 1008 拒绝。请在 mac mini 上直接 grep openclaw 源码定位协议。');
    process.exit(2);
  } else {
    console.log('可能正确的格式：');
    survivors.forEach((s) => console.log(`  → ${s.name}`));
    process.exit(0);
  }
})();
