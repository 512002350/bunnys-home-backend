/**
 * 自主活动引擎 API 路由 — 从 index.js 抽取
 * 端点: /api/autonomous/status | /start | /stop | /trigger
 */

const express = require('express');
const router = express.Router();
const autonomous = require('../services/autonomous');
const { createSession, getSessions } = require('../services/supabase');

/**
 * 确保存在一个"Bunny的主动问候"会话
 */
async function ensureAutonomousSession() {
  try {
    const sessions = await getSessions();
    const existing = sessions.find(s => s.name === 'Bunny的主动问候');
    if (existing) {
      autonomous.setSessionId(existing.id);
      return existing.id;
    }
    const created = await createSession('Bunny的主动问候');
    autonomous.setSessionId(created.id);
    return created.id;
  } catch (err) {
    console.error('[Autonomous] 创建会话失败:', err.message);
    return null;
  }
}

router.get('/status', (req, res) => {
  res.json(autonomous.getStatus());
});

router.post('/start', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    const sid = sessionId || await ensureAutonomousSession();
    autonomous.start(sid);
    res.json({ ok: true, sessionId: sid, status: autonomous.getStatus() });
  } catch (err) { next(err); }
});

router.post('/stop', (req, res) => {
  autonomous.stop();
  res.json({ ok: true, status: autonomous.getStatus() });
});

router.post('/trigger', async (req, res, next) => {
  try {
    if (!autonomous.getStatus().autonomousSessionId) {
      await ensureAutonomousSession();
    }
    const result = await autonomous.trigger();
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

module.exports = router;
