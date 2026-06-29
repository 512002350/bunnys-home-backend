const express = require('express');
const router = express.Router();
const { getSettings, updateSettings } = require('../services/supabase');

// GET /api/settings — 获取系统设置
router.get('/', async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /api/settings — 更新系统设置
router.put('/', async (req, res, next) => {
  try {
    const allowedFields = [
      'system_prompt',
      'temperature',
      'context_rounds',
      'compression_threshold_tokens',
      'compressed_rounds_to_keep',
      'max_response_tokens',
    ];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '没有有效的更新字段' });
    }
    const settings = await updateSettings(updates);
    res.json({ settings });
  } catch (err) { next(err); }
});

module.exports = router;
