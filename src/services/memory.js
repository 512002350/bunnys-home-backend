/**
 * 记忆压缩引擎
 *
 * 当对话 token 量超过阈值时：
 *   1. 取出最早 N 轮
 *   2. 调便宜模型（DeepSeek）压缩为摘要
 *   3. 摘要存 memories 表，原消息标记 invisible
 */

const { callModel, estimateMessagesTokens } = require('./ai');
const { getMemories, insertMemory, hideMessages, getSettings } = require('./supabase');

/**
 * 将消息按"轮"分组（user + assistant = 一轮）
 */
function groupIntoRounds(messages) {
  const rounds = [];
  let currentRound = [];

  for (const msg of messages) {
    currentRound.push(msg);
    if (msg.role === 'assistant') {
      rounds.push(currentRound);
      currentRound = [];
    }
  }
  // 如果最后一条是 user 消息（还没回复），也作为一轮
  if (currentRound.length > 0) {
    rounds.push(currentRound);
  }
  return rounds;
}

/**
 * 估算当前会话上下文的总 token 消耗
 * 包括：系统提示词 + 记忆摘要 + 可见消息
 */
function estimateContextTokens(systemPrompt, memorySummaries, messages) {
  let total = 0;
  total += Math.ceil((systemPrompt?.length || 0) / 3.5);
  for (const m of memorySummaries) {
    total += m.token_count || Math.ceil((m.summary?.length || 0) / 3.5);
  }
  total += estimateMessagesTokens(messages);
  return total;
}

/**
 * 检查是否需要压缩，如果需要则执行压缩
 * @param {Array} visibleMessages - 当前会话的可见消息
 * @param {object} settings - 系统设置
 * @returns {object|null} 如果压缩了返回新摘要信息，否则返回 null
 */
async function maybeCompress(visibleMessages, settings) {
  // 没有足够消息可压缩
  if (visibleMessages.length < 4) return null;

  const rounds = groupIntoRounds(visibleMessages);
  const keepRounds = settings.compressed_rounds_to_keep || 3;

  // 至少要保留 keepRounds 轮
  if (rounds.length <= keepRounds) return null;

  const toCompress = rounds.slice(0, rounds.length - keepRounds);
  if (toCompress.length === 0) return null;

  const flatMessages = toCompress.flat();
  const tokensToCompress = estimateMessagesTokens(flatMessages);

  // 压缩的内容太短就不压了（至少 500 token 才值得）
  if (tokensToCompress < 500) return null;

  console.log(`[Memory] 触发压缩：${flatMessages.length} 条消息（约 ${tokensToCompress} token）→ 保留最近 ${keepRounds} 轮`);

  // 调 DeepSeek 压缩
  const compressionModel = 'deepseek-chat';
  const text = flatMessages
    .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
    .join('\n\n');

  try {
    const result = await callModel(
      // 伪装成一条用户消息让压缩模型处理
      [{ role: 'user', content: text }],
      compressionModel,
      { temperature: 0.3, max_response_tokens: 800 },
      `你是一个对话摘要助手。请将以下对话片段压缩为一段简短的摘要。
要求：
- 保留关键事实和决定
- 保留用户的偏好、习惯和个人信息
- 保留重要的情感内容
- 保留未完成的事项或待办
- 用第三人称描述用户，用"AI"指代你自己
- 输出纯文本，不要用 markdown 格式`
    );

    const summary = result.content?.trim();
    if (!summary || summary.length < 20) {
      console.log('[Memory] 压缩结果太短，跳过');
      return null;
    }

    // 存摘要
    const memory = await insertMemory(
      summary,
      flatMessages.map(m => m.id)
    );

    // 隐藏被压缩的原始消息
    await hideMessages(flatMessages.map(m => m.id));

    console.log(`[Memory] 压缩完成：${summary.length} 字符摘要已存储`);
    return memory;
  } catch (err) {
    console.error('[Memory] 压缩失败:', err.message);
    return null;
  }
}

/**
 * 全量检查：如果上下文 token 超过阈值，执行压缩
 * 在组装上下文之前调用
 */
async function compressIfNeeded(visibleMessages) {
  try {
    const settings = await getSettings();
    const memories = await getMemories();

    // 估算当前上下文总 token
    const totalTokens = estimateContextTokens(
      settings.system_prompt,
      memories,
      visibleMessages
    );

    const threshold = settings.compression_threshold_tokens || 8000;

    if (totalTokens < threshold) {
      return { compressed: false, totalTokens, threshold };
    }

    console.log(`[Memory] Token 超阈值: ${totalTokens}/${threshold}，开始压缩...`);
    const result = await maybeCompress(visibleMessages, settings);

    // 重新估算
    const newMemories = result ? [...memories, result] : memories;
    const remainingMessages = result
      ? visibleMessages.filter(m => !result.compressed_message_ids?.includes(m.id))
      : visibleMessages;
    const newTotal = estimateContextTokens(settings.system_prompt, newMemories, remainingMessages);

    return {
      compressed: !!result,
      totalTokens: newTotal,
      threshold,
      newMemory: result,
    };
  } catch (err) {
    console.error('[Memory] compressIfNeeded 异常:', err.message);
    return { compressed: false, error: err.message };
  }
}

module.exports = {
  groupIntoRounds,
  estimateContextTokens,
  maybeCompress,
  compressIfNeeded,
};
