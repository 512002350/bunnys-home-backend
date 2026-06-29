/**
 * 华为 Health Kit 直连客户端
 *
 * 华为运动健康 App 自动同步到华为云 → 后端定时拉取 → 注入对话。
 *
 * OAuth 流程：
 *   1. GET /api/health/huawei/auth → 浏览器访问，跳转华为登录页
 *   2. 用华为账号登录并授权
 *   3. 自动回调到我们后端，保存 refresh token
 *   4. 后续自动用 refresh token 续期，定时拉数据
 */

const { insertHealthData, getSetting, setSetting } = require('./supabase');

const AUTH_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const HEALTH_API = 'https://health-api.cloud.huawei.com/healthkit/v1';

// 需要的权限 scope
// 华为 Health Kit 云侧 REST API（healthkit 命名空间，非 health）
// 官方 scope 列表: https://developer.huawei.com/consumer/cn/doc/HMSCore-Guides-V5/scope-list-0000001055419280-V5
const SCOPES = [
  'openid',
  'https://www.huawei.com/healthkit/step.read',
  'https://www.huawei.com/healthkit/heartrate.read',
  'https://www.huawei.com/healthkit/sleep.read',
].join(' ');

let cachedToken = null;
let tokenExpiry = 0;

// ---- OAuth ----

/** 生成授权 URL — 用户浏览器访问即跳转华为登录 */
function getAuthUrl(backendUrl) {
  const clientId = process.env.HUAWEI_APP_ID;
  if (!clientId) throw new Error('未配置 HUAWEI_APP_ID');
  const redirectUri = `${backendUrl}/api/health/huawei/callback`;
  const state = Math.random().toString(36).slice(2, 10);
  // display=page 是华为 OAuth 的必传参数（PC 端页面），mobile 用 touch
  return `${AUTH_URL}?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES)}&state=${state}&access_type=offline&display=page`;
}

/** 用 authorization code 换 token */
async function exchangeCode(code, backendUrl) {
  const clientId = process.env.HUAWEI_APP_ID;
  const clientSecret = process.env.HUAWEI_APP_SECRET;
  if (!clientId || !clientSecret) throw new Error('未配置 HUAWEI_APP_ID / HUAWEI_APP_SECRET');

  const redirectUri = `${backendUrl}/api/health/huawei/callback`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('Huawei token exchange failed:', data);
    throw new Error(data.error_description || data.error || 'token exchange failed');
  }

  // 保存 refresh token 到 Supabase settings 表
  if (data.refresh_token) {
    await setSetting('huawei_refresh_token', data.refresh_token);
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('Huawei token exchange success:', { hasRefreshToken: !!data.refresh_token, expires_in: data.expires_in });
  return { access_token: data.access_token, expires_in: data.expires_in, refresh_token: data.refresh_token };
}

/** 获取有效 access token（自动续期） */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 60000) {
    return cachedToken;
  }

  // 优先从 settings 表拿 refresh token，回退到 env
  let refreshToken = await getSetting('huawei_refresh_token');
  if (!refreshToken) refreshToken = process.env.HUAWEI_REFRESH_TOKEN;
  if (!refreshToken) {
    console.log('🫀 华为 Health Kit 未授权，请先访问 /api/health/huawei/auth');
    return null;
  }

  const clientId = process.env.HUAWEI_APP_ID;
  const clientSecret = process.env.HUAWEI_APP_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    console.error('Huawei token refresh failed:', res.status);
    return null;
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in || 3600) * 1000;

  if (data.refresh_token) {
    await setSetting('huawei_refresh_token', data.refresh_token);
  }

  return cachedToken;
}

// ---- 数据拉取 ----

/** 从 JWT access_token 解析 userId（华为 token 的 sub 字段） */
function parseUserId(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    return decoded.sub || decoded.open_id || decoded.user_id || null;
  } catch (e) {
    console.error('Failed to parse userId from token:', e.message);
    return null;
  }
}

/** 获取当前用户 ID（缓存 2 小时，跟 token 同生命周期） */
let cachedUserId = null;
function getUserId(token) {
  if (!cachedUserId) {
    cachedUserId = parseUserId(token);
  }
  return cachedUserId;
}

/** 毫秒时间戳 */
function toMillis(date) {
  return date.getTime();
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return { startTime: toMillis(start), endTime: toMillis(new Date()) };
}

function lastNightRange() {
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  start.setHours(20, 0, 0, 0);
  return { startTime: toMillis(start), endTime: toMillis(end) };
}

async function healthApiGet(token, path, params = {}) {
  const clientId = process.env.HUAWEI_APP_ID;
  const url = new URL(`${HEALTH_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-client-id': clientId,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Health Kit API ${path} failed (${res.status}):`, text.slice(0, 200));
    return null;
  }
  return res.json();
}

/** 拿今日步数 */
async function getSteps(token) {
  const userId = getUserId(token);
  if (!userId) { console.error('Cannot get userId for steps API'); return null; }
  const range = todayRange();
  const data = await healthApiGet(token, `/users/${userId}/steps`, {
    startTime: range.startTime,
    endTime: range.endTime,
  });
  if (!data) return null;
  // 返回格式: { items: [{ value, startTime, endTime }, ...] } 或类似
  const items = data.items || data.records || [];
  let total = 0;
  for (const r of items) {
    total += r.value || r.count || 0;
  }
  return total || null;
}

/** 拿最近心率 */
async function getHeartRate(token) {
  const userId = getUserId(token);
  if (!userId) { console.error('Cannot get userId for heartRate API'); return null; }
  const start = toMillis(new Date(Date.now() - 2 * 3600 * 1000));
  const end = toMillis(new Date());
  const data = await healthApiGet(token, `/users/${userId}/heartRate`, {
    startTime: start,
    endTime: end,
  });
  if (!data) return null;
  const items = data.items || data.records || [];
  if (items.length === 0) return null;
  const latest = items[items.length - 1];
  return latest.value || null;
}

/** 拿昨晚睡眠 */
async function getSleep(token) {
  const userId = getUserId(token);
  if (!userId) { console.error('Cannot get userId for sleep API'); return null; }
  const range = lastNightRange();
  const data = await healthApiGet(token, `/users/${userId}/sleep`, {
    startTime: range.startTime,
    endTime: range.endTime,
  });
  if (!data) return null;
  const items = data.items || data.records || [];
  if (items.length === 0) return null;

  let totalMinutes = 0;
  let deepMinutes = 0;
  let lightMinutes = 0;
  for (const r of items) {
    // sleepStages 包含阶段数组: [{ stage: 'deep'|'light'|'rem'|'awake'|'unknown', duration(秒) }]
    const stages = r.sleepStages || [];
    for (const s of stages) {
      const mins = Math.round((s.duration || 0) / 60); // 秒 → 分钟
      totalMinutes += mins;
      if (s.stage === 'deep') deepMinutes += mins;
      else if (s.stage === 'light' || s.stage === 'rem') lightMinutes += mins;
    }
    // 兼容旧格式：直接有 duration 字段（分钟）
    if (stages.length === 0 && r.duration) {
      totalMinutes += r.duration;
      if (r.sleepType === 1) deepMinutes += r.duration;
      else lightMinutes += r.duration;
    }
  }

  if (totalMinutes === 0) return null;
  return { sleep_total: totalMinutes, sleep_deep: deepMinutes, sleep_light: lightMinutes };
}

// ---- 主入口 ----

async function pullAndStore() {
  const token = await getAccessToken();
  if (!token) return { error: 'no_token', reason: '无法获取 access token，请检查 refresh_token 是否配置' };

  const userId = getUserId(token);
  const diag = { userId, tokenPrefix: token.slice(0, 20) + '...', steps: null, heartRate: null, sleep: null };

  try {
    const [steps, hr, sleep] = await Promise.all([
      getSteps(token).catch(e => ({ _error: e.message })),
      getHeartRate(token).catch(e => ({ _error: e.message })),
      getSleep(token).catch(e => ({ _error: e.message })),
    ]);

    diag.steps = steps?._error ? { error: steps._error } : (steps ?? 'no_data');
    diag.heartRate = hr?._error ? { error: hr._error } : (hr ?? 'no_data');
    diag.sleep = sleep?._error ? { error: sleep._error } : (sleep ?? 'no_data');

    if (steps?._error || hr?._error || sleep?._error) {
      return { ok: false, diag, reason: 'API 调用出错' };
    }

    const payload = {
      source: 'huaweiHealthKit',
      recorded_at: new Date().toISOString(),
    };
    if (steps) payload.steps = steps;
    if (hr) payload.heart_rate = hr;
    if (sleep) {
      payload.sleep_total = sleep.sleep_total;
      payload.sleep_deep = sleep.sleep_deep;
      payload.sleep_light = sleep.sleep_light;
    }

    if (!steps && !hr && !sleep) {
      console.log('🫀 华为 Health Kit 无新数据');
      return { ok: true, result: null, diag, reason: '时间范围内无数据（手环可能未同步或今日无记录）' };
    }

    const saved = await insertHealthData(payload);
    console.log('🫀 华为 Health Kit 数据已拉取:', JSON.stringify(payload));
    return { ok: true, result: saved, diag };
  } catch (err) {
    console.error('Huawei Health Kit pull failed:', err.message);
    return { ok: false, error: err.message, diag };
  }
}

module.exports = { getAuthUrl, exchangeCode, getAccessToken, pullAndStore };
