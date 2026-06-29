const express = require('express');
const router = express.Router();
const { insertHealthData, getLatestHealth } = require('../services/supabase');

// POST /api/health/update — 手环/MacroDroid 推送健康数据
router.post('/update', async (req, res, next) => {
  try {
    const { heart_rate, steps, sleep_total, sleep_deep, sleep_light, calories, recorded_at, source } = req.body;

    // 至少要有一种数据
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

// GET /api/health/latest — 获取最近健康摘要（前端调试用）
router.get('/latest', async (req, res, next) => {
  try {
    const summary = await getLatestHealth();
    res.json({ summary, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
