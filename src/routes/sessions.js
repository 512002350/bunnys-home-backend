const express = require('express');
const router = express.Router();
const {
  getSessions,
  createSession,
  updateSession,
  deleteSession,
  getVisibleMessages,
} = require('../services/supabase');

// GET /api/sessions — 获取所有会话
router.get('/', async (req, res, next) => {
  try {
    const sessions = await getSessions();
    res.json({ sessions });
  } catch (err) { next(err); }
});

// POST /api/sessions — 创建新会话
router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body;
    const session = await createSession(name || '新对话');
    res.status(201).json({ session });
  } catch (err) { next(err); }
});

// PUT /api/sessions/:id — 重命名会话
router.put('/:id', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: '缺少 name' });
    const session = await updateSession(req.params.id, { name });
    res.json({ session });
  } catch (err) { next(err); }
});

// DELETE /api/sessions/:id — 删除会话（级联删除消息）
router.delete('/:id', async (req, res, next) => {
  try {
    await deleteSession(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/sessions/:id/messages — 获取会话的所有可见消息
router.get('/:id/messages', async (req, res, next) => {
  try {
    const messages = await getVisibleMessages(req.params.id);
    res.json({ messages });
  } catch (err) { next(err); }
});

module.exports = router;
