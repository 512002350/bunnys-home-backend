const express = require('express');
const router = express.Router();
const { insertHealthData, getLatestHealth } = require('../services/supabase');
const { pullAndStore } = require('../services/googleFit');

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

// POST /api/health/pull — 手动触发 Google Fit 拉取
router.post('/pull', async (req, res, next) => {
  try {
    const result = await pullAndStore();
    res.json({ ok: true, result });
  } catch (err) {
    next(err);
  }
});

// GET /api/health/status — 查 Google Fit 配置状态
router.get('/status', async (req, res) => {
  res.json({
    googleFitConfigured: !!(process.env.GOOGLE_FIT_CLIENT_ID && process.env.GOOGLE_FIT_CLIENT_SECRET && process.env.GOOGLE_FIT_REFRESH_TOKEN),
    manualPushEnabled: true,
  });
});

module.exports = router;
