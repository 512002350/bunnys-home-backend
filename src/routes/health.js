const express = require('express');
const router = express.Router();
const { insertHealthData, getLatestHealth } = require('../services/supabase');
const { getAuthUrl, exchangeCode, pullAndStore } = require('../services/huaweiHealth');

// ===================== 手动推送（MacroDroid 等） =====================

// POST /api/health/update — 手环/MacroDroid 推送健康数据
router.post('/update', async (req, res, next) => {
  try {
    const { heart_rate, steps, sleep_total, sleep_deep, sleep_light, calories, recorded_at, source } = req.body;

    if (!heart_rate && !steps && !sleep_total) {
      return res.status(400).json({ error: '至少需要 heart_rate / steps / sleep_total 之一' });
    }

    const saved = await insertHealthData({
      heart_rate: heart_rate ? parseInt(heart_rate) : null,
      steps: steps ? parseInt(steps) : null,
      sleep_total: sleep_total ? parseInt(sleep_total) : null,
      sleep_deep: sleep_deep ? parseInt(sleep_deep) : null,
      sleep_light: sleep_light ? parseInt(sleep_light) : null,
      calories: calories ? parseInt(calories) : null,
      source: source || 'macroDroid',
      recorded_at: recorded_at || new Date().toISOString(),
    });

    res.json({ ok: true, id: saved.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/health/latest — 获取最近健康摘要
router.get('/latest', async (req, res, next) => {
  try {
    const summary = await getLatestHealth();
    res.json({ summary, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// ===================== 华为 Health Kit 授权 =====================

// GET /api/health/huawei/auth — 发起华为 OAuth 授权
router.get('/huawei/auth', async (req, res, next) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const backendUrl = `${protocol}://${req.get('host')}`;
    const url = getAuthUrl(backendUrl);
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`<h2>授权失败</h2><p>${err.message}</p><p>请检查 HUAWEI_APP_ID 是否已配置到 Render 环境变量。</p>`);
  }
});

// GET /api/health/huawei/callback — 华为 OAuth 回调（浏览器跳转回来）
router.get('/huawei/callback', async (req, res, next) => {
  try {
    const { code, state, error: authError } = req.query;

    if (authError) {
      return res.send(`<h2>❌ 授权被取消</h2><p>错误：${authError}</p>`);
    }
    if (!code) {
      return res.send(`<h2>❌ 缺少授权码</h2><p>请重新访问授权页面。</p>`);
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const backendUrl = `${protocol}://${req.get('host')}`;
    const tokenData = await exchangeCode(code, backendUrl);

    // 显示 refresh token 给用户，让他们复制到 Render 环境变量
    const refreshToken = tokenData.refresh_token || '（无法获取，请重试）';
    res.send(`
      <!DOCTYPE html>
      <html lang="zh">
      <head><meta charset="UTF-8"><title>授权成功</title>
      <style>
        body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; padding: 20px; color: #333; }
        h2 { color: #8b7fcf; }
        .box { background: #f5f4f3; padding: 16px; border-radius: 8px; word-break: break-all; font-family: monospace; font-size: 13px; margin: 12px 0; }
        .step { color: #888; font-size: 13px; margin-top: 20px; }
        .done { color: #4caf50; font-weight: 600; }
      </style></head>
      <body>
        <h2>✅ 授权成功！</h2>
        <p>华为 Health Kit 已连接到 Bunny's Home。</p>
        <p class="step">📋 把下面的 Refresh Token 添加到 <b>Render 后台 → Environment</b>：</p>
        <div class="box">HUAWEI_REFRESH_TOKEN=${refreshToken}</div>
        <p class="step">添加后点 Save → 等待重新部署 → Bunny 就会自动拉取你的健康数据了 🐰</p>
        <p class="done">每 30 分钟自动拉取一次。</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<h2>❌ 授权失败</h2><p>${err.message}</p><p>请重新尝试授权。</p>`);
  }
});

// POST /api/health/pull — 手动触发拉取（调试用）
// GET 也支持，方便浏览器直接访问测试
router.all('/pull', async (req, res, next) => {
  try {
    const result = await pullAndStore();
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// GET /api/health/status — 查询配置状态
router.get('/status', async (req, res) => {
  res.json({
    huaweiHealthKitConfigured: !!(process.env.HUAWEI_APP_ID && process.env.HUAWEI_APP_SECRET),
    hasRefreshToken: !!(process.env.HUAWEI_REFRESH_TOKEN),
    manualPushEnabled: true,
  });
});

module.exports = router;
