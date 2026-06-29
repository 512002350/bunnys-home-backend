/**
 * Google Fit REST API 客户端
 *
 * 一次性授权后可自动刷新 token，定时拉取步数/心率/睡眠。
 *
 * 你需要准备的环境变量：
 *   GOOGLE_FIT_CLIENT_ID      — Google Cloud OAuth 2.0 客户端 ID
 *   GOOGLE_FIT_CLIENT_SECRET  — 客户端密钥
 *   GOOGLE_FIT_REFRESH_TOKEN  — 刷新令牌（用 OAuth Playground 拿到）
 *
 * 获取 refresh token 的最快方式：
 *   1. 打开 https://console.cloud.google.com → 创建项目 → 启用 Fitness API
 *   2. 凭据 → 创建 OAuth 2.0 客户端 ID → "Web 应用"
 *   3. 打开 https://developers.google.com/oauthplayground
 *   4. 右上角齿轮 → 勾 "Use your own OAuth credentials" → 填入 ID + Secret
 *   5. 左边选 Fitness API v1 的 scope → 点 Authorize → 授权
 *   6. Exchange authorization code for tokens → 拿到 refresh_token
 *   7. 填入 .env 的 GOOGLE_FIT_REFRESH_TOKEN
 */

const { insertHealthData } = require('./supabase');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FITNESS_API = 'https://www.googleapis.com/fitness/v1';

let cachedAccessToken = null;
let tokenExpiry = 0;

// ---- OAuth ----

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiry - 60000) {
    return cachedAccessToken;
  }

  const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_FIT_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_FIT_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null; // 还没配置，静默跳过
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    console.error('Google Fit token refresh failed:', res.status);
    return null;
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  tokenExpiry = now + (data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

// ---- 数据拉取 ----

/** 聚合查询：某个数据类型今天的数据 */
async function aggregateToday(token, dataTypeName) {
  const now = Date.now();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const body = {
    aggregateBy: [{ dataTypeName }],
    bucketByTime: { durationMillis: 86400000 },
    startTimeMillis: startOfDay.getTime(),
    endTimeMillis: now,
  };

  const res = await fetch(`${FITNESS_API}/users/me/dataset:aggregate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) return null;
  return res.json();
}

/** 拿今日步数 */
async function getSteps(token) {
  const data = await aggregateToday(token, 'com.google.step_count.delta');
  if (!data || !data.bucket) return null;

  let total = 0;
  for (const bucket of data.bucket) {
    for (const ds of bucket.dataset || []) {
      for (const pt of ds.point || []) {
        for (const v of pt.value || []) {
          total += v.intVal || 0;
        }
      }
    }
  }
  return total || null;
}

/** 拿最近心率 */
async function getHeartRate(token) {
  const now = Date.now();
  // 查最近 2 小时
  const body = {
    aggregateBy: [{ dataTypeName: 'com.google.heart_rate.bpm' }],
    bucketByTime: { durationMillis: 7200000 },
    startTimeMillis: now - 7200000,
    endTimeMillis: now,
  };

  const res = await fetch(`${FITNESS_API}/users/me/dataset:aggregate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.bucket) return null;

  let latest = null;
  let latestTime = 0;
  for (const bucket of data.bucket) {
    for (const ds of bucket.dataset || []) {
      for (const pt of ds.point || []) {
        const t = parseInt(pt.endTimeNanos) / 1e6 || 0;
        if (t > latestTime) {
          latestTime = t;
          latest = pt.value?.[0]?.fpVal || pt.value?.[0]?.intVal || null;
        }
      }
    }
  }
  return latest ? Math.round(latest) : null;
}

/** 拿昨晚睡眠 */
async function getSleep(token) {
  const now = new Date();
  // 昨晚 20:00 → 今天 12:00
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  start.setHours(20, 0, 0, 0);
  const end = new Date(now);
  end.setHours(12, 0, 0, 0);

  const body = {
    aggregateBy: [{ dataTypeName: 'com.google.sleep.segment' }],
    bucketByTime: { durationMillis: end.getTime() - start.getTime() },
    startTimeMillis: start.getTime(),
    endTimeMillis: end.getTime(),
  };

  const res = await fetch(`${FITNESS_API}/users/me/dataset:aggregate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.bucket) return null;

  let totalMinutes = 0;
  let deepMinutes = 0;
  let lightMinutes = 0;

  for (const bucket of data.bucket) {
    for (const ds of bucket.dataset || []) {
      for (const pt of ds.point || []) {
        const startMs = parseInt(pt.startTimeNanos) / 1e6;
        const endMs = parseInt(pt.endTimeNanos) / 1e6;
        const dur = Math.round((endMs - startMs) / 60000);
        const type = pt.value?.[0]?.intVal || 0;
        // type: 1=Awake, 2=Sleep(light), 3=Deep, 4=REM
        if (type === 2 || type === 4) lightMinutes += dur;
        else if (type === 3) deepMinutes += dur;
        totalMinutes += dur;
      }
    }
  }

  if (totalMinutes === 0) return null;
  return { sleep_total: totalMinutes, sleep_deep: deepMinutes, sleep_light: lightMinutes };
}

// ---- 主入口：一次拉全 ----

async function pullAndStore() {
  const token = await getAccessToken();
  if (!token) {
    console.log('🫀 Google Fit 未配置或 token 已失效，跳过健康数据拉取');
    return null;
  }

  try {
    const [steps, hr, sleep] = await Promise.all([
      getSteps(token),
      getHeartRate(token),
      getSleep(token),
    ]);

    const payload = {
      source: 'googleFit',
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
      console.log('🫀 Google Fit 无新数据');
      return null;
    }

    const saved = await insertHealthData(payload);
    console.log('🫀 Google Fit 数据已拉取:', payload);
    return saved;
  } catch (err) {
    console.error('Google Fit pull failed:', err.message);
    return null;
  }
}

module.exports = { pullAndStore, getAccessToken, getSteps, getHeartRate, getSleep };
