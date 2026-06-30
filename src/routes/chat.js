const express = require('express');
const router = express.Router();
const { processChat, recordTypingEvent } = require('../services/chat');
const { noteUserActivity } = require('../services/autonomous');

// 后端的 sticker tag 替换逻辑：把 [sticker:名字] 换成前端能识别的图片标记
// 前端收到后渲染 <img> 标签
const stickerService = require('../services/stickers');
const skills = require('../services/skills');

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

// POST /api/chat/upload-image — 聊天图片上传（拍照/图库 → DeepSeek 识图 → 存文件）
router.post('/chat/upload-image', async (req, res, next) => {
  try {
    const path = require('path');
    const fs = require('fs');
    const crypto = require('crypto');
    const { describeImage } = require('../services/imageVision');

    const { sessionId, imageBase64, mimeType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: '缺少 imageBase64 参数' });
    }

    const mime = mimeType || 'image/jpeg';
    const ext = mime.split('/')[1] || 'jpg';

    // 1. 调 DeepSeek 视觉识别
    const description = await describeImage(imageBase64, mime);

    // 2. 保存图片到 public/uploads/
    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const filename = `img-${crypto.randomUUID()}.${ext}`;
    const filePath = path.join(uploadsDir, filename);
    const buffer = Buffer.from(imageBase64, 'base64');
    fs.writeFileSync(filePath, buffer);

    const url = `/uploads/${filename}`;

    console.log(`[Chat] 图片已上传: ${url} (${buffer.length} bytes), 描述: ${description.slice(0, 60)}...`);

    res.json({ url, description, id: filename.replace(`.${ext}`, '') });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat — 核心对话接口（委托给 services/chat.js）
router.post('/chat', async (req, res, next) => {
  try {
    const { sessionId, message, model, character, typingMetrics, imageDescription } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: '缺少 sessionId 或 message' });
    }

    // 通知自主活动引擎：用户刚刚发了消息（重置空闲计时）
    noteUserActivity();

    // 创建 AbortController，客户端断开时触发 abort → 取消正在进行的 AI 调用
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const reply = await processChat(sessionId, message, model, {
      character,
      typingMetrics,
      imageDescription,
      abortSignal: abortController.signal,
    });
    res.json(reply);
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/typing-event — 前端推送输入行为事件（光标空闲/删了又打等犹豫信号）
// 这些事件会缓存在内存中，在用户下次发送消息时注入系统提示词
router.post('/chat/typing-event', (req, res) => {
  try {
    const { sessionId, type, data } = req.body;
    if (!sessionId || !type) {
      return res.status(400).json({ error: '缺少 sessionId 或 type' });
    }

    const validTypes = ['cursor_idle', 'delete_retype', 'abandoned_input', 'close_reopen'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: '无效的 type，支持：' + validTypes.join(', ') });
    }

    recordTypingEvent(sessionId, { type, data });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/extract-context — 提取并保存关键上下文（跨会话保留）
router.post('/chat/extract-context', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' });

    const { getVisibleMessages } = require('../services/supabase');
    const { callModel } = require('../services/ai');
    const { getSettings } = require('../services/supabase');
    const { preserveContext } = require('../services/userProfile');

    const messages = await getVisibleMessages(sessionId);
    if (messages.length < 2) {
      return res.json({ ok: false, message: '对话太短，无需提取上下文' });
    }

    // 取最近 10 轮对话
    const recent = messages.slice(-20);
    const conversationText = recent.map(m => `${m.role === 'user' ? '我' : '对方'}：${m.content}`).join('\n');

    const settings = await getSettings();

    // 用便宜模型提取关键上下文
    const extractionPrompt = await skills.resolve('tool-extract-context', {
      conversationText,
    }).catch(() => `你是一个对话摘要助手。请从以下对话中提取需要在未来会话中记住的关键信息...对话内容：\n${conversationText}`);

    const result = await callModel(
      [{ role: 'user', content: extractionPrompt }],
      'deepseek-chat',
      { ...settings, temperature: 0.3, max_response_tokens: 500 }
    );

    // 解析 JSON
    let extracted;
    try {
      const content = result.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (_) {
      extracted = null;
    }

    if (!extracted?.key_points?.length) {
      return res.json({ ok: false, message: '未能提取到关键信息' });
    }

    preserveContext({
      summary: extracted.summary || '',
      key_points: extracted.key_points.slice(0, 5),
      sessionId,
    });

    res.json({
      ok: true,
      summary: extracted.summary,
      key_points: extracted.key_points,
      message: `已保存 ${extracted.key_points.length} 条关键信息，新会话将自动携带`,
    });
  } catch (err) { next(err); }
});

// POST /api/chat/compact — 手动触发内存压缩
router.post('/chat/compact', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: '缺少 sessionId' });

    const { compressIfNeeded } = require('../services/memory');
    const { getVisibleMessages } = require('../services/supabase');
    const messages = await getVisibleMessages(sessionId);
    const result = await compressIfNeeded(messages, true); // force=true

    res.json({
      compressed: result.compressed,
      totalTokens: result.totalTokens,
      threshold: result.threshold,
      newFacts: result.newFacts || 0,
      message: result.compressed
        ? `已压缩，生成 ${result.newFacts || 0} 条记忆`
        : '当前未达到压缩阈值',
    });
  } catch (err) { next(err); }
});

// POST /api/chat/retract — 撤回最后一条用户消息及后续 AI 回复
router.post('/chat/retract', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: '缺少 sessionId' });
    }

    const { hideMessage, getVisibleMessages } = require('../services/supabase');

    // 找到最后一条可见的用户消息
    const visibleMessages = await getVisibleMessages(sessionId);
    const lastUserIdx = [...visibleMessages].reverse().findIndex(m => m.role === 'user');

    if (lastUserIdx === -1) {
      return res.status(404).json({ error: '没有可撤回的用户消息' });
    }

    // 撤回该用户消息及之后的所有 AI 回复
    const toHide = visibleMessages.slice(visibleMessages.length - 1 - lastUserIdx);
    const hideIds = toHide.map(m => m.id);

    for (const id of hideIds) {
      await hideMessage(id);
    }

    console.log(`[Chat] 撤回 ${hideIds.length} 条消息: ${hideIds.join(', ')}`);
    res.json({ ok: true, hidden: hideIds.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/retry — 重新生成 AI 回复（替换最后一条 AI 消息）
router.post('/chat/retry', async (req, res, next) => {
  try {
    const { sessionId, model } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: '缺少 sessionId' });
    }

    const { hideMessage, getLastUserMessage } = require('../services/supabase');

    // 1. 找到最后一条可见的 AI 回复并隐藏
    const { getVisibleMessages } = require('../services/supabase');
    const visibleMessages = await getVisibleMessages(sessionId);
    const lastAiMsg = [...visibleMessages].reverse().find(m => m.role === 'assistant');

    if (lastAiMsg) {
      await hideMessage(lastAiMsg.id);
      console.log(`[Chat] 隐藏旧回复 ${lastAiMsg.id}`);
    }

    // 2. 找到最后一条用户消息（可见的）
    const lastUserMsg = await getLastUserMessage(sessionId);
    if (!lastUserMsg) {
      return res.status(404).json({ error: '未找到可重试的用户消息' });
    }

    // 3. 创建 AbortController，客户端断开时中止
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    // 4. 用同一用户消息重新处理（透传 abortSignal）
    const reply = await processChat(sessionId, lastUserMsg.content, model, {
      abortSignal: abortController.signal,
    });

    res.json({ ...reply, retried: true });
  } catch (err) {
    next(err);
  }
});

// ---- 角色系统管理 ----

const characterService = require('../services/character');
const userProfileService = require('../services/userProfile');

// 获取可用角色列表
router.get('/characters', (req, res) => {
  const available = characterService.listCharacters();
  const current = characterService.getCharacter();
  res.json({
    current: current.id,
    characters: available.map(c => ({
      id: c.id,
      name: c.identity?.name || c.id,
      gender: c.identity?.gender || '未知',
      description: c.identity?.occupation || '',
    })),
  });
});

// 获取当前角色卡
router.get('/character', (req, res) => {
  const char = characterService.getCharacter();
  const profile = userProfileService.getProfile();
  res.json({
    character: {
      id: char.id,
      name: char.identity.name,
      age: char.identity.age,
      gender: char.identity.gender,
      occupation: char.identity.occupation,
      version: char.version,
      evolution_notes: char.evolution_notes?.slice(-10) || [],
    },
    relationship: {
      stage: characterService.inferRelationshipStage(profile),
      known_facts_count: profile.known_facts.length,
      shared_experiences_count: profile.shared_experiences.length,
      total_messages: profile.total_messages_exchanged,
      markers: profile.relationship_markers,
    },
  });
});

// 更新/切换角色卡（手动微调 或 切换角色）
router.put('/character', (req, res) => {
  try {
    // 如果传了 character 字段，切换角色
    if (req.body.character && typeof req.body.character === 'string') {
      const switched = characterService.loadCharacter(req.body.character);
      return res.json({ ok: true, switched: true, character: switched.identity.name, id: switched.id });
    }
    // 否则更新当前角色卡
    const updated = characterService.updateCharacter(req.body);
    res.json({ ok: true, version: updated.version });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 获取用户画像（她了解你什么）
router.get('/profile', (req, res) => {
  const profile = userProfileService.getProfile();
  res.json({
    known_facts: profile.known_facts.slice(-30),
    shared_experiences: profile.shared_experiences.slice(-15),
    observed_patterns: profile.observed_patterns,
    relationship_markers: profile.relationship_markers,
    stats: {
      total_messages: profile.total_messages_exchanged,
      deep_conversations: profile.deep_conversations,
      first_chat: profile.first_chat_at,
    },
  });
});

// 手动添加一条用户事实（调试/手动输入用）
router.post('/profile/fact', (req, res) => {
  const { content, source, importance } = req.body;
  if (!content) return res.status(400).json({ error: '缺少 content' });
  const fact = userProfileService.addKnownFact(content, source || 'user_stated', importance || 5);
  res.json({ fact });
});

// ---- 反思系统管理 ----

const reflectionService = require('../services/reflection');

router.get('/lessons', (req, res) => {
  res.json({ lessons: reflectionService.getAllLessons() });
});

router.post('/lessons', (req, res) => {
  const { pattern, lesson, context } = req.body;
  if (!pattern || !lesson) {
    return res.status(400).json({ error: '缺少 pattern 或 lesson' });
  }
  const entry = reflectionService.addLesson(pattern, lesson, context || 'manual');
  res.json({ lesson: entry });
});

router.delete('/lessons/:id', (req, res) => {
  const ok = reflectionService.removeLesson(req.params.id);
  if (!ok) return res.status(404).json({ error: '未找到该经验' });
  res.json({ success: true });
});

module.exports = router;
