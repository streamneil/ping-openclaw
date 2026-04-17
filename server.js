/**
 * Openclaw Gateway Bridge — 基于 openclaw-studio 的实现方式
 *
 * 架构：浏览器 <——WS(前端协议)——> 本服务(Adapter) <——WS(gateway-client/operator)——> Openclaw Gateway
 *
 * 关键事实（来自 openclaw-studio 源码的 controlplane/openclaw-adapter.ts）：
 *   - Gateway 的首帧必须是 {type:"req", id, method:"connect", params:{...}}，token 放在 params.auth.token
 *   - backend-local profile: client.id="gateway-client", mode="backend", platform="node" —— 走 operator 角色
 *     这条路径不需要 Origin 校验、不需要 device pairing，避开了 webchat 的一切坑
 *   - 连接上后：req/res 通过 id 配对；event 是单向推送
 *
 * 前端协议（本服务暴露给浏览器的简化层）：
 *   proxy_status: {type:"proxy_status", state, message}   —— 链路状态
 *   来自 gateway 的 event/res  —— 原样透传 JSON
 *   浏览器发来的纯文本  —— 自动包装成 chat.send 请求
 *   浏览器发来的 JSON {method, params}  —— 转成 req 转发（id 由本服务分配）
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { randomUUID } = require('crypto');

require('dotenv').config();

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: Number(process.env.PORT) || 8192,
  HOST: process.env.HOST || '127.0.0.1',
  OPENCLAW_WS_URL: process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',
  OPENCLAW_TOKEN: process.env.OPENCLAW_TOKEN || '',
  PUBLIC_DIR: path.join(__dirname, 'public'),
  DEBUG_WS: String(process.env.DEBUG_WS || '').toLowerCase() === 'true',
  CONNECT_TIMEOUT_MS: 8000,
  HEARTBEAT_INTERVAL: 25000,
  RECONNECT_INITIAL_MS: 1000,
  RECONNECT_MAX_MS: 15000,
};

// openclaw-studio 的 connect 协议常量
const CONNECT_PROTOCOL = 3;
const CONNECT_CAPABILITIES = ['tool-events'];
const OPERATOR_SCOPES = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
];
const CLIENT_PROFILES = {
  'backend-local':     { id: 'gateway-client',       version: 'dev', platform: 'node', mode: 'backend' },
  'legacy-control-ui': { id: 'openclaw-control-ui',  version: 'dev', platform: 'web',  mode: 'webchat' },
};

// 判断是否属于 openclaw-studio 里定义的「operator scope 缺失」错误 —— 需要切换到 legacy 身份
function shouldFallbackToLegacy(err) {
  if (!err) return false;
  const code = typeof err.code === 'string' ? err.code.trim().toUpperCase() : '';
  if (code !== 'INVALID_REQUEST') return false;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('missing scope: operator.read') ||
    msg.includes('missing scope: operator.write') ||
    msg.includes('missing scope: operator.admin')
  );
}

function deriveLegacyOrigin(wsUrl) {
  try {
    const u = new URL(wsUrl);
    const scheme = u.protocol === 'wss:' ? 'https:' : 'http:';
    // 127.0.0.1 / ::1 / 0.0.0.0 → localhost（gateway 的允许名单里通常是 localhost）
    const host = ['127.0.0.1', '::1', '0.0.0.0'].includes(u.hostname) ? 'localhost' : u.hostname;
    return `${scheme}//${u.port ? `${host}:${u.port}` : host}`;
  } catch (_) {
    return null;
  }
}

// 方法白名单（借自 openclaw-studio 的 DEFAULT_METHOD_ALLOWLIST）
const METHOD_ALLOWLIST = new Set([
  'status',
  'chat.send',
  'chat.abort',
  'chat.history',
  'agents.create',
  'agents.update',
  'agents.delete',
  'agents.list',
  'agents.files.get',
  'agents.files.set',
  'sessions.list',
  'sessions.preview',
  'sessions.patch',
  'sessions.reset',
  'cron.list',
  'cron.run',
  'cron.remove',
  'cron.add',
  'config.get',
  'config.set',
  'models.list',
  'exec.approval.resolve',
  'exec.approvals.get',
  'exec.approvals.set',
  'agent.wait',
]);

if (!CONFIG.OPENCLAW_TOKEN) {
  console.warn('[Bridge] ⚠ 环境变量 OPENCLAW_TOKEN 为空，gateway 连接一定会被拒');
}

// ─── Gateway Adapter（参考 openclaw-studio OpenClawGatewayAdapter）──────────
class GatewayAdapter {
  constructor() {
    this.ws = null;
    this.status = 'stopped';
    this.statusReason = null;
    this.connectRequestId = null;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopping = false;
    this.nextRequestNumber = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.listeners = new Set(); // 接收 {kind:"status"|"event"|"response"|"raw", ...}
    this.profileId = 'backend-local'; // 被拒后自动切 legacy-control-ui
    this.switching = false;
    this.defaultAgentId = null;
    this.defaultSessionKey = null;
    this.mainKey = 'main';
  }

  getDefaults() {
    return {
      agentId: this.defaultAgentId,
      sessionKey: this.defaultSessionKey,
      mainKey: this.mainKey,
    };
  }

  async _hydrateDefaultAgent() {
    // 使用 request() 而不是 _requestOnce：如果 token 在 backend-local 下没有 operator.read
    // （= 这个 token 绑定为 webchat 身份），会自动切到 legacy-control-ui 重试
    const result = await this.request('agents.list', {}, 8000);
    const mainKey = (result?.mainKey && String(result.mainKey).trim()) || 'main';
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    if (agents.length === 0) {
      console.warn('[Bridge] agents.list 返回空，chat.send 需要前端显式传 sessionKey');
      this.defaultAgentId = null;
      this.defaultSessionKey = null;
      this.mainKey = mainKey;
      return;
    }
    const first = agents[0];
    const id = typeof first?.id === 'string' ? first.id : null;
    if (!id) {
      console.warn('[Bridge] agents.list 第一个 agent 没有 id 字段');
      return;
    }
    this.defaultAgentId = id;
    this.mainKey = mainKey;
    this.defaultSessionKey = `agent:${id}:${mainKey}`;
    const label = typeof first?.name === 'string' ? first.name : id;
    console.log(`[Bridge] 默认 agent = ${label} (id=${id})，sessionKey = ${this.defaultSessionKey}`);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn({ kind: 'status', status: this.status, reason: this.statusReason });
    return () => this.listeners.delete(fn);
  }

  emit(msg) {
    for (const fn of this.listeners) {
      try { fn(msg); } catch (err) { console.error('[Bridge] listener error:', err); }
    }
  }

  start() {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.stopping = false;
    this._connect();
  }

  _updateStatus(status, reason) {
    this.status = status;
    this.statusReason = reason ?? null;
    this.emit({ kind: 'status', status, reason: reason ?? null });
  }

  _connect() {
    const profile = this._buildConnectParams();
    const headers = {};
    // legacy-control-ui profile 需要伪装 Origin 绕过 CONTROL_UI_ORIGIN_NOT_ALLOWED；
    // backend-local 不需要 Origin，也不需要 HTTP Bearer —— 鉴权走 connect 帧的 params.auth.token。
    if (this.profileId === 'legacy-control-ui') {
      const origin = deriveLegacyOrigin(CONFIG.OPENCLAW_WS_URL);
      if (origin) headers.Origin = origin;
    }
    console.log(`[Bridge] connect profile = ${this.profileId}`);
    this._updateStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', null);

    const ws = new WebSocket(CONFIG.OPENCLAW_WS_URL, { headers });
    this.ws = ws;
    this.connectRequestId = null;

    this.connectTimer = setTimeout(() => {
      console.warn('[Bridge] connect 超时');
      try { ws.close(1011, 'connect timeout'); } catch (_) {}
    }, CONFIG.CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      console.log(`[Bridge] ✓ upstream WS 已握手 → ${CONFIG.OPENCLAW_WS_URL}`);
      // 按 openclaw-studio 的实际做法：open 后不要立即发 connect，而是等 gateway 推 connect.challenge event
      // 但若 gateway 实现上允许客户端主动 connect（实测可以），也 OK。这里严格照搬：等 challenge。
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (CONFIG.DEBUG_WS) console.log(`[${ts()}] ⇠ GATEWAY ${truncate(text)}`);
      const frame = this._parseFrame(text);
      if (!frame) return;

      if (frame.type === 'event') {
        if (frame.event === 'connect.challenge') {
          this._sendConnectRequest(profile);
          return;
        }
        this.emit({ kind: 'event', frame });
        return;
      }
      if (frame.type === 'res') {
        // connect 响应：切到 connected 或抛错
        if (frame.id === this.connectRequestId) {
          if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
          if (frame.ok) {
            this.reconnectAttempt = 0;
            console.log('[Bridge] ✓ connect 成功，gateway 已进入 operator 模式');
            this._updateStatus('connected', null);
            // 拉取默认 agent 与 sessionKey，供 chat.send 使用
            this._hydrateDefaultAgent().catch((e) =>
              console.warn(`[Bridge] agents.list 失败: ${e.message}`)
            );
          } else {
            const code = frame.error?.code || 'CONNECT_FAILED';
            const message = frame.error?.message || 'Connect failed.';
            console.error(`[Bridge] ✗ connect 被 gateway 拒绝: ${code} ${message}`);
            this._updateStatus('error', `${code} ${message}`);
            try { ws.close(1011, 'connect failed'); } catch (_) {}
          }
          return;
        }
        // 普通 req 的响应
        const pending = this.pending.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else pending.reject(Object.assign(new Error(frame.error?.message || 'Gateway error'), {
            code: frame.error?.code || 'GATEWAY_REQUEST_FAILED',
            details: frame.error?.details,
          }));
        }
        this.emit({ kind: 'response', frame });
        return;
      }
    });

    ws.on('close', (code, reason) => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      const reasonText = reason?.toString() || '';
      console.log(`[Bridge] upstream 关闭 code=${code} reason=${reasonText}`);
      this._rejectAllPending('upstream closed');
      if (this.stopping) {
        this._updateStatus('stopped', null);
        return;
      }
      this._updateStatus('reconnecting', `gateway_closed(${code})${reasonText ? ': ' + reasonText : ''}`);
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error(`[Bridge] upstream 错误: ${err.message}`);
      this._updateStatus('error', err.message);
    });
  }

  _sendConnectRequest(params) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.connectRequestId) return;
    const id = String(this.nextRequestNumber++);
    this.connectRequestId = id;
    const frame = { type: 'req', id, method: 'connect', params };
    if (CONFIG.DEBUG_WS) console.log(`[${ts()}] ⇢ GATEWAY ${truncate(JSON.stringify(frame))}`);
    ws.send(JSON.stringify(frame));
  }

  _buildConnectParams() {
    return {
      minProtocol: CONNECT_PROTOCOL,
      maxProtocol: CONNECT_PROTOCOL,
      client: { ...CLIENT_PROFILES[this.profileId] },
      role: 'operator',
      scopes: [...OPERATOR_SCOPES],
      caps: [...CONNECT_CAPABILITIES],
      auth: { token: CONFIG.OPENCLAW_TOKEN },
    };
  }

  _parseFrame(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.type !== 'string') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  _rejectAllPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  _scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(
      CONFIG.RECONNECT_INITIAL_MS * Math.pow(1.7, this.reconnectAttempt),
      CONFIG.RECONNECT_MAX_MS
    );
    this.reconnectAttempt += 1;
    console.log(`[Bridge] ${Math.round(delay)}ms 后重连（第 ${this.reconnectAttempt} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  /**
   * 发送一个业务 req，返回 Promise。id 本适配器自动分配；调用方不得自带 id。
   * 若返回「missing scope: operator.*」，自动切 legacy-control-ui profile 重试一次。
   */
  async request(method, params, timeoutMs = 15000) {
    try {
      return await this._requestOnce(method, params, timeoutMs);
    } catch (err) {
      if (shouldFallbackToLegacy(err) && this.profileId === 'backend-local') {
        console.log(`[Bridge] 被 gateway 拒（${err.code}: ${err.message}）→ 切换到 legacy-control-ui 重连后重试`);
        await this._switchToLegacyProfile();
        return this._requestOnce(method, params, timeoutMs);
      }
      throw err;
    }
  }

  _requestOnce(method, params, timeoutMs) {
    if (!METHOD_ALLOWLIST.has(method)) {
      return Promise.reject(Object.assign(new Error(`method not allowlisted: ${method}`), {
        code: 'METHOD_NOT_ALLOWED',
      }));
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== 'connected') {
      return Promise.reject(Object.assign(new Error('gateway unavailable'), {
        code: 'GATEWAY_UNAVAILABLE',
      }));
    }
    const id = String(this.nextRequestNumber++);
    const frame = { type: 'req', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (CONFIG.DEBUG_WS) console.log(`[${ts()}] ⇢ GATEWAY ${truncate(JSON.stringify(frame))}`);
      ws.send(JSON.stringify(frame), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async _switchToLegacyProfile() {
    if (this.switching) return;
    this.switching = true;
    // 标记 stopping 避免旧 ws 的 close handler 触发 scheduleReconnect
    this.stopping = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try {
      this.profileId = 'legacy-control-ui';
      const ws = this.ws;
      this.ws = null;
      this.connectRequestId = null;
      this._rejectAllPending('switching profile');
      if (ws) {
        await new Promise((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.once('close', () => resolve());
          try { ws.close(1000, 'switching profile'); } catch (_) { resolve(); }
        });
      }
      this.stopping = false;
      this.reconnectAttempt = 0;
      // 直接走一次 _connect 并等到 status=connected（或 error）
      await new Promise((resolve, reject) => {
        const off = this.subscribe((msg) => {
          if (msg.kind !== 'status') return;
          if (msg.status === 'connected') { off(); resolve(); }
          else if (msg.status === 'error') { off(); reject(new Error(msg.reason || 'connect error')); }
        });
        this._connect();
      });
    } finally {
      this.switching = false;
      this.stopping = false;
    }
  }
}

// ─── HTTP + WS Server ────────────────────────────────────────────────────────
const app = express();
app.use(express.static(CONFIG.PUBLIC_DIR));

const adapter = new GatewayAdapter();
adapter.start();

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    upstream: CONFIG.OPENCLAW_WS_URL,
    port: CONFIG.PORT,
    adapterStatus: adapter.status,
    reason: adapter.statusReason,
    clients: wss ? wss.clients.size : 0,
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log('[Bridge] 服务启动中（adapter 模式 — openclaw-studio 风格）');
console.log(`[Bridge] 监听地址:   ${CONFIG.HOST}:${CONFIG.PORT}`);
console.log(`[Bridge] 底层引擎:   ${CONFIG.OPENCLAW_WS_URL}`);
console.log(`[Bridge] Token:      ${CONFIG.OPENCLAW_TOKEN ? '******(已注入)' : '(未配置)'}`);
console.log(`[Bridge] 调试报文:   ${CONFIG.DEBUG_WS ? 'ON' : 'OFF'}`);

// ─── 每个前端连接 ─────────────────────────────────────────────────────────
wss.on('connection', (frontend, req) => {
  const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[Bridge] [${clientId}] 前端已连接`);

  // 订阅 adapter 状态 / 事件 / 响应
  const unsubscribe = adapter.subscribe((msg) => {
    if (frontend.readyState !== WebSocket.OPEN) return;
    if (msg.kind === 'status') {
      sendJson(frontend, {
        type: 'proxy_status',
        state: mapAdapterStateToFrontend(msg.status),
        message: msg.reason || '',
      });
    } else if (msg.kind === 'event') {
      if (isNoisyEvent(msg.frame)) return;
      sendJson(frontend, msg.frame);
    } else if (msg.kind === 'response') {
      sendJson(frontend, msg.frame);
    }
  });

  // 立即汇报当前 adapter 状态（若已连上，前端会直接解锁输入）
  // 已在 subscribe 回调首发中完成

  frontend.on('message', (raw) => {
    const text = raw.toString();
    if (CONFIG.DEBUG_WS) console.log(`[${ts()}] [${clientId}] ⇢ FRONTEND ${truncate(text)}`);

    // 尝试 JSON 形式：{method, params, [clientRef]}
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* 纯文本 */ }

    if (parsed && typeof parsed === 'object' && typeof parsed.method === 'string') {
      handleFrontendRpc(frontend, parsed);
      return;
    }

    // 纯文本 → 默认走 chat.send（需要 sessionKey / idempotencyKey）
    const defaults = adapter.getDefaults();
    if (!defaults.sessionKey) {
      sendJson(frontend, {
        type: 'res',
        ok: false,
        method: 'chat.send',
        error: { code: 'NO_AGENT', message: 'gateway 未返回任何 agent，请先在 openclaw 里创建一个' },
      });
      return;
    }
    const runId = randomUUID();
    handleFrontendRpc(frontend, {
      method: 'chat.send',
      params: {
        sessionKey: defaults.sessionKey,
        message: text,
        deliver: false,
        idempotencyKey: runId,
      },
      clientRef: runId,
    });
  });

  frontend.on('close', (code) => {
    console.log(`[Bridge] [${clientId}] 前端断开 code=${code}`);
    unsubscribe();
  });

  frontend.on('error', (err) => {
    console.error(`[Bridge] [${clientId}] 前端错误: ${err.message}`);
    unsubscribe();
  });

  // 心跳
  if (CONFIG.HEARTBEAT_INTERVAL > 0) {
    const hb = setInterval(() => {
      if (frontend.readyState === WebSocket.OPEN) frontend.ping();
    }, CONFIG.HEARTBEAT_INTERVAL);
    frontend.once('close', () => clearInterval(hb));
  }
});

function handleFrontendRpc(frontend, { method, params, clientRef }) {
  adapter
    .request(method, params)
    .then((payload) => {
      sendJson(frontend, {
        type: 'res',
        ok: true,
        method,
        clientRef: clientRef ?? null,
        payload,
      });
    })
    .catch((err) => {
      sendJson(frontend, {
        type: 'res',
        ok: false,
        method,
        clientRef: clientRef ?? null,
        error: { code: err.code || 'ERROR', message: err.message },
      });
    });
}

// gateway 推的基础设施类事件对前端没意义，过滤掉避免刷屏
const NOISY_EVENT_NAMES = new Set(['tick', 'health']);
function isNoisyEvent(frame) {
  if (!frame || typeof frame.event !== 'string') return false;
  if (NOISY_EVENT_NAMES.has(frame.event)) return true;
  // "empty-heartbeat-file" / skipped 心跳：payload.status=="skipped" && reason 形如 "empty-heartbeat-file"
  const p = frame.payload;
  if (p && typeof p === 'object' && p.status === 'skipped' && typeof p.reason === 'string'
      && p.reason.includes('heartbeat')) {
    return true;
  }
  return false;
}

function mapAdapterStateToFrontend(status) {
  switch (status) {
    case 'connected':      return 'ready';
    case 'connecting':
    case 'reconnecting':   return 'connecting';
    case 'stopped':        return 'closed';
    case 'error':          return 'error';
    default:               return status;
  }
}

// ─── 工具 ────────────────────────────────────────────────────────────────────
function sendJson(socket, obj) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function truncate(s, n = 400) {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}

function ts() {
  return new Date().toISOString();
}

// ─── 启动 ───────────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  const displayHost = CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST;
  console.log(`[Bridge] ✓ HTTP + WebSocket 服务已启动 → http://${displayHost}:${CONFIG.PORT}`);
  if (CONFIG.HOST === '0.0.0.0') {
    console.log('[Bridge] ⚠ HOST=0.0.0.0 — 局域网内任意设备都能访问');
  }
});

process.on('uncaughtException', (err) => console.error('[Bridge] 未捕获的异常:', err));
process.on('unhandledRejection', (r) => console.error('[Bridge] 未处理的 Promise 拒绝:', r));
