const express = require('express');
const router = express.Router();
const {
  getSessions,
  createSession,
  updateSession,
  deleteSession,
  deleteSessionMessages,
  getVisibleMessages,
  getLastMessagesForSessions,
} = require('../services/supabase');

// GET /api/sessions — 获取所有会话（含最后一条消息预览）
router.get('/', async (req, res, next) => {
  try {
    const sessions = await getSessions();

    // 附加最后一条消息作为预览
    if (sessions.length > 0) {
      const sessionIds = sessions.map(s => s.id);
      const lastMsgs = await getLastMessagesForSessions(sessionIds);
      const previewMap = {};
      for (const m of lastMsgs) {
        if (!previewMap[m.session_id]) {
          previewMap[m.session_id] = m.content;
        }
      }
      for (const s of sessions) {
        s.last_message_preview = previewMap[s.id] || '';
      }
    }

    res.json({ sessions });
  } catch (err) { next(err); }
});

// POST /api/sessions — 创建新会话（可选绑定角色）
router.post('/', async (req, res, next) => {
  try {
    const { name, character } = req.body;
    const session = await createSession(name || '新对话', character || 'default');
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

// DELETE /api/sessions/:id/messages — 清空会话的所有消息（保留会话）
router.delete('/:id/messages', async (req, res, next) => {
  try {
    await deleteSessionMessages(req.params.id);
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
