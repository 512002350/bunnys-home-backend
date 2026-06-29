const express = require('express');
const router = express.Router();
const {
  insertMessage,
  getVisibleMessages,
  getMemories,
  getSettings,
  updateSession,
  getLatestHealth,
} = require('../services/supabase');
const { callModel, estimateContextTokens } = require('../services/ai');
const { compressIfNeeded } = require('../services/memory');

// 后端的 sticker tag 替换逻辑：把 [sticker:名字] 换成前端能识别的图片标记
// 前端收到后渲染 <img> 标签
const stickerService = require('../services/stickers');

// GET /api/stickers — 表情库列表（注入 prompt 用）
router.get('/stickers', async (req, res, next) => {
  try {
    const stickers = await stickerService.getStickers();
    res.json({ stickers });
  } catch (err) { next(err); }
});

// POST /api/stickers/upload — 上传表情包（base64 图片 → 视觉模型描述 → 入库）
router.post('/stickers/upload', async (req, res, next) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: '缺少 imageBase64 参数' });
    }
    const sticker = await stickerService.uploadSticker(imageBase64);
    res.json({ sticker });
  } catch (err) { next(err); }
});

// DELETE /api/stickers/:id — 删除表情
router.delete('/stickers/:id', async (req, res, next) => {
  try {
    await stickerService.deleteSticker(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/chat — 核心对话接口
router.post('/chat', async (req, res, next) => {
  try {
    const { sessionId, message, model } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: '缺少 sessionId 或 message' });
    }

    // 1. 存储用户消息
    await insertMessage(sessionId, 'user', message);

    // 2. 加载可见历史消息
    const visibleMessages = await getVisibleMessages(sessionId);

    // 3. 加载系统设置和记忆摘要
    const [settings, memories] = await Promise.all([
      getSettings(),
      getMemories(),
    ]);

    // 4. 检查 token 量，超阈值则压缩
    const compressResult = await compressIfNeeded(visibleMessages);
    // 压缩后重新加载（可能有消息被标记 invisible）
    const currentMessages = compressResult.compressed
      ? await getVisibleMessages(sessionId)
      : visibleMessages;
    const currentMemories = compressResult.newMemory
      ? [...memories, compressResult.newMemory]
      : memories;

    // 5. 加载健康摘要（手环推送的数据）
    let healthSummary = null;
    try {
      healthSummary = await getLatestHealth();
    } catch (e) { /* 静默失败，不影响对话 */ }

    // 6. 加载表情库并注入系统提示词
    const stickers = await stickerService.getStickers();
    let systemPrompt = settings.system_prompt || '';

    // 注入健康数据
    if (healthSummary) {
      systemPrompt += '\n\n（以下是用户最近 24 小时健康数据，可自然地引用来表达关心，但不需逐条复述）：\n' + healthSummary;
    }

    if (stickers.length > 0) {
      systemPrompt += stickerService.stickerPromptBlock(stickers);
    }

    // 7. 组装消息列表（不含系统提示词，由 ai.js 处理）
    const messagesForAI = currentMessages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    // 加上当前用户消息（已入库，但 ai.js 仍需要）
    // 实际上当前消息已经入库且在 visibleMessages 末尾，无需重复添加
    // 但如果刚入库还没刷新到，手动加上
    const hasLatest = messagesForAI.length > 0 &&
      messagesForAI[messagesForAI.length - 1].role === 'user' &&
      messagesForAI[messagesForAI.length - 1].content === message;
    if (!hasLatest) {
      messagesForAI.push({ role: 'user', content: message });
    }

    // 7. 调用模型
    const memoriesForAI = currentMemories.map(m => ({ summary: m.summary }));
    const result = await callModel(
      messagesForAI,
      model || 'anthropic/claude-sonnet-4',
      settings,
      systemPrompt,
      memoriesForAI
    );

    // 8. 处理回复中的 sticker 标记 → 替换为图片 URL 标记
    let replyContent = result.content || '';
    if (stickers.length > 0) {
      replyContent = stickerService.replaceStickerTags(replyContent, stickers);
    }

    // 9. 存储 AI 回复
    const savedMsg = await insertMessage(
      sessionId,
      'assistant',
      replyContent,
      result.thinking || null
    );

    // 10. 更新会话的 updated_at
    await updateSession(sessionId, {});

    // 11. 返回给前端
    res.json({
      reply: replyContent,
      thinking: result.thinking || null,
      model: result.model || model,
      messageId: savedMsg.id,
      sessionId,
      compressed: compressResult.compressed,
      tokenInfo: {
        totalTokens: compressResult.totalTokens,
        threshold: compressResult.threshold,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
