/**
 * 聊天处理核心 —— 抽取自 routes/chat.js
 * 供 HTTP 路由和自主活动引擎共用
 */

const {
  insertMessage,
  getVisibleMessages,
  getSettings,
  updateSession,
  getLatestHealth,
  getSessionCharacter,
} = require('./supabase');
const { callModel, estimateContextTokens } = require('./ai');
const { compressIfNeeded, searchRelevantMemories } = require('./memory');
const stickerService = require('./stickers');
const { lessonsPromptBlock, reflect } = require('./reflection');
const { analyzeStance, toPromptBlock, getTemperatureAdjustment } = require('./stanceReasoner');
const { buildCharacterPrompt, inferRelationshipStage, evolveCharacter, loadCharacter } = require('./character');
const { getProfile, extractFactsFromMessage, addKnownFact, addSharedExperience, recordConversation } = require('./userProfile');

/**
 * 处理一条用户消息，返回 AI 回复的完整结果
 * @param {string} sessionId
 * @param {string} message - 用户消息文本
 * @param {string} model - 模型标识
 * @param {object} [opts]
 * @param {boolean} [opts.skipInsertUser] - 如果用户消息已入库则跳过（自主活动用）
 * @param {string} [opts.character] - 会话绑定的角色 ID（优先于 DB 记录）
 * @returns {object} { reply, thinking, model, messageId, sessionId, compressed, tokenInfo }
 */
async function processChat(sessionId, message, model, opts = {}) {
  // 1. 存储用户消息（如果还没存）
  if (!opts.skipInsertUser) {
    await insertMessage(sessionId, 'user', message);
  }

  // 2. 加载可见历史消息
  const visibleMessages = await getVisibleMessages(sessionId);

  // 3. 加载系统设置 + 用户画像
  const settings = await getSettings();
  const userProfile = getProfile();

  // 4. 检查 token 量，超阈值则压缩
  const compressResult = await compressIfNeeded(visibleMessages);
  const currentMessages = compressResult.compressed
    ? await getVisibleMessages(sessionId)
    : visibleMessages;

  // 5. 向量语义检索相关记忆
  const relevantMemories = await searchRelevantMemories(message, 10);

  // 6. 并行加载：健康数据 + 表情库 + CoT 立场推理
  const [healthSummary, stickers, stanceResult] = await Promise.all([
    getLatestHealth().catch(() => null),
    stickerService.getStickers(),
    analyzeStance(message, currentMessages.slice(-6), relevantMemories).catch(() => null),
  ]);
  // 7. 确定角色：优先用请求中指定的，其次查 DB，最后用 default
  const characterId = opts.character
    || (await getSessionCharacter(sessionId).catch(() => null))
    || 'default';
  loadCharacter(characterId);

  // 8. 构建角色系统提示词（她/他是谁 + 对用户的了解 + 关系阶段）
  const relationshipStage = inferRelationshipStage(userProfile);
  const characterPrompt = buildCharacterPrompt(userProfile, relationshipStage);

  // 9. 组装完整系统提示词：角色身份 + 叙事风格 + 上下文注入
  let systemPrompt = characterPrompt;

  // 追加叙事风格（如果用户配置了）
  const narrativeStyle = settings.system_prompt || '';
  if (narrativeStyle && narrativeStyle.trim().length > 0) {
    systemPrompt += '\n\n# 写作风格要求\n' + narrativeStyle;
  }

  if (healthSummary) {
    systemPrompt += '\n\n（以下是用户最近 24 小时健康数据，可自然地引用来表达关心，但不需逐条复述）：\n' + healthSummary;
  }
  if (stickers.length > 0) {
    systemPrompt += stickerService.stickerPromptBlock(stickers);
  }

  // 10. 注入相关过往经验（反思系统）
  const lessonsBlock = lessonsPromptBlock(message);
  if (lessonsBlock) {
    systemPrompt += lessonsBlock;
  }

  // 11. 注入 CoT 立场推理结果（口是心非识别）
  const stanceBlock = toPromptBlock(stanceResult);
  if (stanceBlock) {
    systemPrompt += stanceBlock;
  }

  // 12. 根据立场推理微调 temperature
  const tempAdjust = getTemperatureAdjustment(stanceResult);
  const adjustedSettings = tempAdjust !== 0
    ? { ...settings, temperature: Math.max(0.1, Math.min(2.0, (settings.temperature || 0.7) + tempAdjust)) }
    : settings;

  // 13. 组装消息列表
  const messagesForAI = currentMessages.map(m => ({
    role: m.role,
    content: m.content,
  }));
  const hasLatest = messagesForAI.length > 0 &&
    messagesForAI[messagesForAI.length - 1].role === 'user' &&
    messagesForAI[messagesForAI.length - 1].content === message;
  if (!hasLatest) {
    messagesForAI.push({ role: 'user', content: message });
  }

  // 14. 调用模型
  const memoriesForAI = relevantMemories.map(m => ({ summary: m.summary }));
  const result = await callModel(
    messagesForAI,
    model || 'anthropic/claude-sonnet-4',
    adjustedSettings,
    systemPrompt,
    memoriesForAI
  );

  // 15. 处理 sticker 标记
  let replyContent = result.content || '';
  if (stickers.length > 0) {
    replyContent = stickerService.replaceStickerTags(replyContent, stickers);
  }

  // 16. 按双换行拆分为多条消息（模拟真人连发节奏）
  //     过滤掉纯空白段、长度不足 2 字符的段
  const segments = replyContent
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);

  // 如果拆分后只有一段（没有空行），就保持原来的单条行为
  const replies = segments.length > 0 ? segments : [replyContent.trim()].filter(s => s.length >= 2);

  // 17. 逐条存储 AI 回复
  const savedMessages = [];
  for (let i = 0; i < replies.length; i++) {
    const msg = await insertMessage(
      sessionId,
      'assistant',
      replies[i],
      i === 0 ? (result.thinking || null) : null  // 只有第一条带 thinking
    );
    savedMessages.push(msg);
  }

  // 18. 更新会话
  await updateSession(sessionId, {});

  // 19. 她从你的消息中了解你（提取事实 + 记录对话）
  try {
    const extractedFacts = extractFactsFromMessage(message);
    for (const fact of extractedFacts) {
      addKnownFact(fact.content, fact.source, fact.importance);
    }
    // 如果有立场推理结果，且置信度高，也记录为"她观察到的"
    if (stanceResult && stanceResult.confidence > 0.6 && stanceResult.implied) {
      addKnownFact(`他说「${message.slice(0, 30)}…」但可能真正的意思是——${stanceResult.implied}`, 'she_inferred', 3);
    }
    recordConversation(2);
  } catch (err) {
    console.error('[UserProfile] 更新失败:', err.message);
  }

  // 20. 异步反思 + 角色演化（不阻塞返回）
  reflect({
    userMessage: message,
    aiReply: replyContent,
    model: model || 'anthropic/claude-sonnet-4',
    wasCompressed: compressResult.compressed,
  }).catch(err => console.error('[Reflection] 反思异常:', err.message));

  // 角色演化（基于 stance 推理的洞察）
  if (stanceResult && stanceResult.confidence > 0.5) {
    evolveCharacter([{
      userAppreciates: stanceResult.hiddenNeed || '',
      userRespondsTo: stanceResult.reverseExpression ? '温柔' : '',
    }]);
  }

  return {
    replies: replies.map((content, i) => ({
      content,
      messageId: savedMessages[i]?.id || `ai-${Date.now()}-${i}`,
      thinking: i === 0 ? (result.thinking || null) : null,
    })),
    model: result.model || model,
    messageId: savedMsg.id,
    sessionId,
    compressed: compressResult.compressed,
    tokenInfo: {
      totalTokens: compressResult.totalTokens,
      threshold: compressResult.threshold,
    },
  };
}

module.exports = { processChat };
