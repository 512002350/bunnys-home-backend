const express = require('express');
const router = express.Router();
const { processChat } = require('../services/chat');
const { noteUserActivity } = require('../services/autonomous');

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

// POST /api/chat — 核心对话接口（委托给 services/chat.js）
router.post('/chat', async (req, res, next) => {
  try {
    const { sessionId, message, model, character } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: '缺少 sessionId 或 message' });
    }

    // 通知自主活动引擎：用户刚刚发了消息（重置空闲计时）
    noteUserActivity();

    const reply = await processChat(sessionId, message, model, { character });
    res.json(reply);
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

    // 3. 找到最后一条用户消息（可见的）
    const lastUserMsg = await getLastUserMessage(sessionId);
    if (!lastUserMsg) {
      return res.status(404).json({ error: '未找到可重试的用户消息' });
    }

    // 4. 用同一用户消息重新处理
    const reply = await processChat(sessionId, lastUserMsg.content, model);

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
