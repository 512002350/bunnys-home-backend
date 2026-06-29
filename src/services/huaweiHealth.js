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
// 华为 scope 格式：openid（必选）+ Health Kit 完整 URL
// 参考 https://developer.huawei.com/consumer/cn/doc/HMSCore-Guides/auth-example-0000001054581058
const SCOPES = [
  'openid',
  // 健康数据只读权限（先打通 OAuth，后续按需加）
  'https://www.huawei.com/healthkit/heartrate.read',
  'https://www.huawei.com/healthkit/step.read',
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

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return {
    startTime: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    endTime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function lastNightRange() {
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  start.setHours(20, 0, 0, 0);
  return {
    startTime: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    endTime: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

async function healthApiGet(token, path, params = {}) {
  const url = new URL(`${HEALTH_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/** 拿今日步数 */
async function getSteps(token) {
  const range = todayRange();
  const data = await healthApiGet(token, '/activityRecords', {
    dataType: 'STEPS',
    startTime: range.startTime,
    endTime: range.endTime,
  });
  if (!data || !data.records) return null;
  let total = 0;
  for (const r of data.records) {
    total += r.value || 0;
  }
  return total || null;
}

/** 拿最近心率 */
async function getHeartRate(token) {
  const range = todayRange();
  // 把开始时间设为 2 小时前，查最近的心率
  const start = new Date(Date.now() - 2 * 3600 * 1000);
  const data = await healthApiGet(token, '/heartRateRecords', {
    startTime: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    endTime: range.endTime,
  });
  if (!data || !data.records || data.records.length === 0) return null;
  const latest = data.records[data.records.length - 1];
  return latest.value || null;
}

/** 拿昨晚睡眠 */
async function getSleep(token) {
  const range = lastNightRange();
  const data = await healthApiGet(token, '/sleepRecords', {
    startTime: range.startTime,
    endTime: range.endTime,
  });
  if (!data || !data.records || data.records.length === 0) return null;

  let totalMinutes = 0;
  let deepMinutes = 0;
  let lightMinutes = 0;
  for (const r of data.records) {
    const dur = r.duration || 0; // 分钟
    totalMinutes += dur;
    // sleepType: 0=浅睡, 1=深睡, 2=REM, 3=清醒
    const type = r.sleepType ?? -1;
    if (type === 1) deepMinutes += dur;
    else if (type === 0 || type === 2) lightMinutes += dur;
  }

  if (totalMinutes === 0) return null;
  return { sleep_total: totalMinutes, sleep_deep: deepMinutes, sleep_light: lightMinutes };
}

// ---- 主入口 ----

async function pullAndStore() {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const [steps, hr, sleep] = await Promise.all([
      getSteps(token),
      getHeartRate(token),
      getSleep(token),
    ]);

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
      return null;
    }

    const saved = await insertHealthData(payload);
    console.log('🫀 华为 Health Kit 数据已拉取:', payload);
    return saved;
  } catch (err) {
    console.error('Huawei Health Kit pull failed:', err.message);
    return null;
  }
}

module.exports = { getAuthUrl, exchangeCode, getAccessToken, pullAndStore };
