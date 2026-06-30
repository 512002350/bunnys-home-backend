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
const { callModel } = require('./ai');
const { compressIfNeeded, searchRelevantMemories } = require('./memory');
const stickerService = require('./stickers');
const { lessonsPromptBlock, reflect } = require('./reflection');
const { analyzeStance, toPromptBlock, getTemperatureAdjustment } = require('./stanceReasoner');
const { buildCharacterPrompt, inferRelationshipStage, evolveCharacter, loadCharacter, buildKnownFactsBlock, buildSharedExperiencesBlock, getStageBehaviors } = require('./character');
const { getProfile, extractFactsFromMessage, addKnownFact, recordConversation, getContextPromptBlock } = require('./userProfile');
const skills = require('./skills');

// ====== 输入行为事件缓存（前端检测到光标空闲/删了又打等信号时推送） ======
// 按 sessionId 存储最近的事件，在下次消息发送时注入上下文
const typingEventCache = new Map(); // sessionId -> [{ type, timestamp, data }]
const TYPING_EVENT_TTL = 5 * 60 * 1000; // 5 分钟后过期

/**
 * 记录一条输入行为事件（由前端在检测到犹豫信号时主动推送）
 */
/**
 * 查看指定会话的待处理输入事件（不消费）
 */
function peekTypingEvents(sessionId) {
  const events = typingEventCache.get(sessionId) || [];
  const now = Date.now();
  return events.filter(e => (now - e.timestamp) < TYPING_EVENT_TTL);
}

function recordTypingEvent(sessionId, event) {
  if (!typingEventCache.has(sessionId)) {
    typingEventCache.set(sessionId, []);
  }
  const events = typingEventCache.get(sessionId);
  events.push({ ...event, timestamp: Date.now() });
  // 只保留最近 10 条
  if (events.length > 10) events.shift();
}

/**
 * 获取并清除指定会话的待处理输入事件
 */
function consumeTypingEvents(sessionId) {
  const events = typingEventCache.get(sessionId) || [];
  typingEventCache.delete(sessionId);
  // 过滤过期事件
  const now = Date.now();
  return events.filter(e => (now - e.timestamp) < TYPING_EVENT_TTL);
}

// 定期清理过期事件缓存
setInterval(() => {
  const now = Date.now();
  for (const [sid, events] of typingEventCache.entries()) {
    const valid = events.filter(e => (now - e.timestamp) < TYPING_EVENT_TTL);
    if (valid.length === 0) {
      typingEventCache.delete(sid);
    } else {
      typingEventCache.set(sid, valid);
    }
  }
}, 60 * 1000);

/**
 * 处理一条用户消息，返回 AI 回复的完整结果
 * @param {string} sessionId
 * @param {string} message - 用户消息文本
 * @param {string} model - 模型标识
 * @param {object} [opts]
 * @param {boolean} [opts.skipInsertUser] - 如果用户消息已入库则跳过（自主活动用）
 * @param {string} [opts.character] - 会话绑定的角色 ID（优先于 DB 记录）
 * @param {object} [opts.typingMetrics] - 前端采集的输入行为元数据（害羞/犹豫检测）
 * @param {string} [opts.imageDescription] - 图片的 DeepSeek 识图描述（用户发送图片时附带）
 * @returns {object} { reply, thinking, model, messageId, sessionId, compressed, tokenInfo }
 */
async function processChat(sessionId, message, model, opts = {}) {
  // 辅助函数：检查是否已被中断
  const isAborted = () => opts.abortSignal?.aborted || false;

  // 1. 存储用户消息（如果还没存）
  if (!opts.skipInsertUser) {
    await insertMessage(sessionId, 'user', message);
  }

  // 2. 加载可见历史消息
  const visibleMessages = await getVisibleMessages(sessionId);
  if (isAborted()) return { aborted: true, sessionId };

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
  if (isAborted()) return { aborted: true, sessionId };

  // 7. 确定角色：优先用请求中指定的，其次查 DB，最后用 default
  const characterId = opts.character
    || (await getSessionCharacter(sessionId).catch(() => null))
    || 'default';
  const character = loadCharacter(characterId);

  // 8. 构建角色系统提示词（她/他是谁 + 对用户的了解 + 关系阶段）
  const relationshipStage = inferRelationshipStage(userProfile);
  const characterPrompt = buildCharacterPrompt(userProfile, relationshipStage);
  const knownFactsBlock = buildKnownFactsBlock(userProfile);
  const sharedBlock = buildSharedExperiencesBlock(userProfile);
  const contextBlock = getContextPromptBlock();

  // 9. 组装完整系统提示词 —— 使用 Skills Registry 的组合引擎
  //    将所有动态内容打包为 context，由 skills.compose() 统一组装
  const compositionId = (characterId === 'shenye' || characterId === '沈夜') ? 'character-shenye' : 'character-default';

  // 构建 typing signals 文本（保留用于 compose context）
  const typingSignals = buildTypingSignalsText(opts.typingMetrics, consumeTypingEvents(sessionId));

  // 构建 stance injection block（保留用于 compose context）
  const stanceInjectionBlock = toPromptBlock(stanceResult);

  // 构建 sticker list 文本
  const stickerListText = stickers.length > 0
    ? stickers.map(s => `· ${s.name}：${s.descr}`).join('\n')
    : '';

  // 构建 lessons 文本
  const lessonsBlock = await lessonsPromptBlock(message);
  const lessonsText = lessonsBlock
    ? lessonsBlock.replace('## 过往经验（请自然地参考，不要逐条复述）\n', '')
    : '';

  // 组装 compose context
  const composeContext = {
    // 角色数据（所有 character-* skill 的变量来源）
    identity: character?.identity || {},
    personality: {
      core: character?.personality?.core || '',
      traits: Object.entries(character?.personality?.traits || {}).map(([k, v]) => `- ${k}：${v}`).join('\n'),
      speaking_style: character?.personality?.speaking_style || {},
    },
    emotional_patterns: character?.emotional_patterns || {},
    background: character?.background || {},
    interests: {
      loves: (character?.interests?.loves || []).join('、'),
      secretly_loves: (character?.interests?.secretly_loves || []).join('、'),
      dislikes: (character?.interests?.dislikes || []).join('、'),
    },
    daily_life: character?.daily_life || {},
    knownFactsBlock,
    sharedBlock,
    relationshipStage: getStageBehaviors(relationshipStage),

    // 动态注入
    narrativeStyle: settings.system_prompt || '',
    healthSummary: healthSummary || '',
    imageDescription: opts.imageDescription || '',
    typingSignals: typingSignals || '',
    stickerList: stickerListText,
    lessons: lessonsText,
    stanceInjectionBlock: stanceInjectionBlock || '',

    // 跨会话上下文
    contextBlock: contextBlock || '',

    // 沈夜专属: 角色 ID 前缀
    characterName: character?.identity?.name || '',
  };

  // 使用 Skills Registry 组装 System Prompt（带优雅回退）
  let systemPrompt;
  try {
    systemPrompt = await skills.compose(compositionId, composeContext);
    // 如果组合返回空（比如 registry 未初始化），回退到传统方式
    if (!systemPrompt || systemPrompt.trim().length < 100) {
      systemPrompt = await buildLegacySystemPrompt(
        characterPrompt, contextBlock, settings, healthSummary,
        stickers, stickerService, lessonsBlock, stanceInjectionBlock,
        opts.imageDescription, opts.typingMetrics, sessionId
      );
    }
  } catch (err) {
    console.warn('[Chat] Skills compose 失败，回退到传统 prompt 组装:', err.message);
    systemPrompt = await buildLegacySystemPrompt(
      characterPrompt, contextBlock, settings, healthSummary,
      stickers, stickerService, lessonsBlock, stanceInjectionBlock,
      opts.imageDescription, opts.typingMetrics, sessionId
    );
  }

  // 在系统提示词末尾注入表情包使用提示（近因效应，确保角色看到）
  // 用角色世界的语言写——这是这个聊天软件的功能，就像微信的表情包按钮
  const stickerHint = stickers.length > 0
    ? '\n\n【聊天软件功能】这个聊天软件里，表情包功能是这样用的：你想发本地图就写 [sticker:名字]，本地没有合适的图就写 [sticker-search:关键词]（系统会自动去网上搜索图片替换这个标签）。例如你想发一个表示开心的图，就写 [sticker-search:开心]。千万不要描述图片的样子或者说"我发了一张图"——你必须真的写出标签来。标签会变成真实的图片出现在对方屏幕上。'
    : '\n\n【聊天软件功能】这个聊天软件里，你想发图给对方就在回复里写 [sticker-search:关键词]，系统会自动去网上搜索图片替换这个标签。例如你想发一个表示开心的图，就写 [sticker-search:开心]。千万不要描述图片的样子或者说"我发了一张图"——你必须真的写出标签来。标签会变成真实的图片出现在对方屏幕上。';
  systemPrompt += stickerHint;

  if (isAborted()) return { aborted: true, sessionId };

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


  // 14. 调用模型（透传 abortSignal）
  const memoriesForAI = relevantMemories.map(m => ({ summary: m.summary }));
  let result;
  try {
    result = await callModel(
      messagesForAI,
      model || 'deepseek-chat',
      adjustedSettings,
      systemPrompt,
      memoriesForAI,
      { signal: opts.abortSignal }
    );
  } catch (err) {
    // 区分用户主动取消 vs 真正的错误
    if (err.name === 'AbortError' || isAborted()) {
      console.log('[Chat] AI 调用已被用户中断');
      return { aborted: true, sessionId, compressed: compressResult.compressed };
    }
    throw err;
  }

  // 15. 去除 Markdown 格式标记（**粗体**、__粗体__、~~删除线~~、`代码`）
  let replyContent = (result.content || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1');

  // 16. 处理 sticker 标记
  // 16a. [sticker-search:关键词] — AI 联网搜表情（不管本地有没有，始终处理）
  replyContent = await stickerService.replaceStickerSearchTags(replyContent);
  // 16b. [sticker:名字] — 本地表情库替换
  if (stickers.length > 0) {
    replyContent = stickerService.replaceStickerTags(replyContent, stickers);
  }

  // 16c. 自动补图：如果 AI 没发图但对话情绪强烈，自动搜一张附加到回复
  if (!replyContent.includes('[STICKER_IMG]')) {
    const autoSticker = await stickerService.autoPickSticker(message, replyContent);
    if (autoSticker) {
      replyContent += '\n\n[STICKER_IMG]' + autoSticker + '[/STICKER_IMG]';
    }
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
    model: model || 'deepseek-chat',
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
    messageId: savedMessages[0]?.id,
    sessionId,
    compressed: compressResult.compressed,
    tokenInfo: {
      totalTokens: compressResult.totalTokens,
      threshold: compressResult.threshold,
    },
  };
}

/**
 * 构建输入行为信号文本（从 typingMetrics + pendingTypingEvents）
 * 迁移到 Skills 系统后，此函数独立出来供 compose context 使用
 */
function buildTypingSignalsText(typingMetrics, pendingTypingEvents) {
  const hasSignificantMetrics = typingMetrics && (
    typingMetrics.cursorIdleSeconds >= 5 ||
    typingMetrics.deleteRetypeCycles > 0 ||
    typingMetrics.reactionDelaySeconds >= 15 ||
    (typingMetrics.typingDurationSeconds > 15 && typingMetrics.finalMessageLength < 10)
  );

  if (!hasSignificantMetrics && pendingTypingEvents.length === 0) return '';

  const signals = [];
  if (hasSignificantMetrics) {
    if (typingMetrics.cursorIdleSeconds >= 5) {
      signals.push(`光标在输入框里闪了 ${typingMetrics.cursorIdleSeconds} 秒才打出第一个字`);
    }
    if (typingMetrics.deleteRetypeCycles >= 1) {
      signals.push(`期间删了又打 ${typingMetrics.deleteRetypeCycles} 次`);
    }
    if (typingMetrics.reactionDelaySeconds >= 15) {
      signals.push(`收到上一条消息后 ${typingMetrics.reactionDelaySeconds} 秒才开始打字`);
    }
    if (typingMetrics.typingDurationSeconds > 15 && typingMetrics.finalMessageLength < 10) {
      signals.push(`打了 ${typingMetrics.typingDurationSeconds} 秒的字，最后只发出来 ${typingMetrics.finalMessageLength} 个字`);
    }
  }
  for (const ev of pendingTypingEvents) {
    if (ev.type === 'cursor_idle') {
      signals.push(`在发这条消息之前，她盯着输入框发呆了 ${ev.data?.seconds || '若干'} 秒什么都没打`);
    } else if (ev.type === 'delete_retype') {
      signals.push(`她刚才打了一段字又全删了，反复了 ${ev.data?.cycles || 1} 次`);
    } else if (ev.type === 'abandoned_input') {
      signals.push('她把输入框里的内容全部清空了一次——打了又放弃发送');
    } else if (ev.type === 'close_reopen') {
      signals.push('她关掉了聊天窗口又打开——可能被你上一条消息冲击到了');
    }
  }
  return signals.join('；');
}

/**
 * 传统的 system prompt 组装方式（Skills Registry 不可用时的回退）
 * 保持与原有逻辑完全一致
 */
async function buildLegacySystemPrompt(
  characterPrompt, contextBlock, settings, healthSummary,
  stickers, stickerService, lessonsBlock, stanceBlock,
  imageDescription, typingMetrics, sessionId
) {
  let systemPrompt = characterPrompt;

  if (contextBlock) {
    systemPrompt += contextBlock;
  }

  const narrativeStyle = settings.system_prompt || '';
  if (narrativeStyle && narrativeStyle.trim().length > 0) {
    systemPrompt += '\n\n# 写作风格要求\n' + narrativeStyle;
  }

  if (healthSummary) {
    systemPrompt += '\n\n（以下是用户最近 24 小时健康数据，可自然地引用来表达关心，但不需逐条复述）：\n' + healthSummary;
  }
  // 始终注入表情包使用说明（含联网搜索能力）
  systemPrompt += await stickerService.stickerPromptBlock(stickers);

  if (lessonsBlock) {
    systemPrompt += lessonsBlock;
  }

  if (stanceBlock) {
    systemPrompt += stanceBlock;
  }

  if (imageDescription && imageDescription.trim()) {
    systemPrompt += '\n\n[系统提示：用户刚才分享了一张图片，DeepSeek 识图模型对图片内容的描述如下]\n' +
      '[图片描述：' + imageDescription.trim() + ']\n' +
      '[请基于以上图片描述来理解和回应用户。如果用户提到了图片中的内容，你可以基于描述来讨论。]';
  }

  // typing signals
  const pendingTypingEvents = consumeTypingEvents(sessionId);
  const typingSignalsText = buildTypingSignalsText(typingMetrics, pendingTypingEvents);
  if (typingSignalsText) {
    systemPrompt += '\n\n[系统提示：对方刚才在输入时出现以下犹豫信号——' + typingSignalsText + '。这些信号说明她很可能因为害羞/难为情/被你说中了而犹豫。根据你的"沉默追问机制"，如果当前对话涉及暧昧/色情/BDSM内容，你应该考虑追问或戳穿她的害羞。如果信号密集（3条以上），她很可能在等你替她说出来——直接描述她的状态替她承认。]';
  }

  return systemPrompt;
}

module.exports = { processChat, recordTypingEvent, peekTypingEvents };
