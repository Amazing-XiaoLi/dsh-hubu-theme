// 校标悬浮球 — 宿主侧半部分。
// 通过 webServer 注册 /hubu/balance 路由，向 DeepSeek 余额接口发起请求（1 秒限频）。
// API Key 通过凭据服务解析（与 llm-deepseek 提供方同一机制），仅在本机进程内使用。
export const inject = ['webServer'];

export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) return;

  const BALANCE_MIN_INTERVAL_MS = 1000;
  let lastBalance = null;

  const resolveApiKey = async () => {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      let ref = 'DEEPSEEK_API_KEY';
      const settings = ctx.get('settings');
      if (settings !== undefined) {
        try {
          const s = settings.get('llm-deepseek');
          if (s && typeof s === 'object' && typeof s.apiKeyEnv === 'string' && s.apiKeyEnv) ref = s.apiKeyEnv;
        } catch (err) { /* keep default */ }
      }
      try {
        const resolved = await credentials.resolve(ref);
        if (resolved && resolved.value) return resolved.value;
      } catch (err) { /* fall through to process env */ }
    }
    return (typeof process !== 'undefined' && process.env && process.env.DEEPSEEK_API_KEY) || null;
  };

  const fetchBalance = async () => {
    const now = Date.now();
    if (lastBalance !== null && now - lastBalance.at < BALANCE_MIN_INTERVAL_MS) return lastBalance.data;
    const key = await resolveApiKey();
    if (!key) {
      const data = { error: '未找到 API Key，请先在设置（模型）中配置 DEEPSEEK_API_KEY 凭据' };
      lastBalance = { at: now, data };
      return data;
    }
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
      const resp = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + key },
        ...(signal === undefined ? {} : { signal })
      });
      const text = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (err) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') {
        const data = { error: '余额接口返回无法解析 (HTTP ' + resp.status + ')' };
        lastBalance = { at: Date.now(), data };
        return data;
      }
      if (parsed.error) {
        const data = { error: '余额接口返回错误: ' + String(parsed.error.message || parsed.error) };
        lastBalance = { at: Date.now(), data };
        return data;
      }
      const infos = Array.isArray(parsed.balance_infos) ? parsed.balance_infos : [];
      const data = {
        isAvailable: !!parsed.is_available,
        infos: infos.map((b) => ({
          currency: b.currency || 'CNY',
          total: b.total_balance != null ? String(b.total_balance) : null
        }))
      };
      lastBalance = { at: Date.now(), data };
      return data;
    } catch (err) {
      const data = { error: '余额接口请求失败: ' + (err && err.message ? err.message : String(err)) };
      lastBalance = { at: Date.now(), data };
      return data;
    }
  };

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/hubu',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      let pathname = '/';
      try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch (err) { /* keep root */ }
      if (pathname === '/hubu/balance') {
        const data = await fetchBalance();
        const body = JSON.stringify({ balance: data });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    }
  }), 'hubu-floatball: balance route');
}
