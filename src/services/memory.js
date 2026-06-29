/**
 * 记忆压缩引擎 v2 —— 拆碎 + 向量检索
 *
 * 当对话 token 量超过阈值时：
 *   1. 取出最早 N 轮
 *   2. 调便宜模型（DeepSeek）拆解为独立事实（每条一行）
 *   3. 每条事实单独 embedding → 存入 memories 表
 *   4. 原消息标记 invisible
 *
 * 检索时：
 *   - 用户消息 → embedding → pgvector 语义搜索 → Top-N 相关记忆注入
 *   - 只注入相关的，不浪费 token
 */

const { callModel, estimateMessagesTokens } = require('./ai');
const { getMemories, insertMemory, searchMemoriesByEmbedding, hideMessages, deleteMemories, getSettings, reheatMemories } = require('./supabase');
const { getEmbedding, getEmbeddings } = require('./embedding');

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
      `你是一个对话摘要助手。请将以下对话片段拆解为独立的记忆事实，每条一行。
要求：
- 每条事实独立、语义边界清晰（一条事实 = 一个可独立检索的信息点）
- 保留关键事实和决定
- 保留用户的偏好、习惯和个人信息
- 保留重要的情感内容
- 保留未完成的事项或待办
- 用第三人称描述用户，用"AI"指代你自己
- 每条不超过 80 字
- 输出纯文本，每行一条事实，不要编号、不要 markdown、不要空行`
    );

    const rawOutput = result.content?.trim();
    if (!rawOutput || rawOutput.length < 10) {
      console.log('[Memory] 压缩结果太短，跳过');
      return null;
    }

    // 拆行 → 过滤 → 去重
    const facts = rawOutput
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 5 && s.length < 200);
    const uniqueFacts = [...new Set(facts)];

    if (uniqueFacts.length === 0) {
      console.log('[Memory] 无有效事实，跳过');
      return null;
    }

    console.log(`[Memory] 压缩产生 ${uniqueFacts.length} 条独立事实`);

    // 批量生成 embedding
    const embeddings = await getEmbeddings(uniqueFacts);

    // 逐条存入 memories 表（每条独立 embedding）
    const msgIds = flatMessages.map(m => m.id);
    const inserted = [];
    for (let i = 0; i < uniqueFacts.length; i++) {
      const mem = await insertMemory(uniqueFacts[i], msgIds, {
        embedding: embeddings[i] || null,
        factType: 'fact',
      });
      if (mem) inserted.push(mem);
    }

    // 隐藏被压缩的原始消息
    await hideMessages(msgIds);

    console.log(`[Memory] 压缩完成：${inserted.length} 条事实已存储（${inserted.filter(m => m.embedding).length} 条有向量）`);
    return inserted;
  } catch (err) {
    console.error('[Memory] 压缩失败:', err.message);
    return null;
  }
}

/**
 * 语义搜索相关记忆（向量检索入口）
 * P0-4: 用 pgvector 做语义相似度搜索，只取 Top-N 相关记忆
 * @param {string} query - 用户消息文本
 * @param {number} limit - 返回条数
 * @returns {Array} 相关记忆列表
 */
async function searchRelevantMemories(query, limit = 10) {
  if (!query || query.trim().length === 0) return [];

  try {
    const embedding = await getEmbedding(query);
    if (!embedding) {
      // embedding 失败时回退到全量加载
      console.log('[Memory] Embedding 失败，回退到全量加载');
      return getMemories();
    }

    const results = await searchMemoriesByEmbedding(embedding, 0.3, limit);
    if (!results || results.length === 0) {
      console.log('[Memory] 无相关记忆');
      return [];
    }

    // 召回加热：被检索到的记忆提升热度
    const ids = results.map(r => r.id).filter(Boolean);
    if (ids.length > 0) {
      reheatMemories(ids, 0.3).catch(err =>
        console.error('[Memory] 召回加热失败:', err.message)
      );
    }

    console.log(`[Memory] 向量检索命中 ${results.length} 条相关记忆（已加热）`);
    return results;
  } catch (err) {
    console.error('[Memory] 向量检索异常:', err.message);
    return getMemories(); // 回退
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
    const inserted = await maybeCompress(visibleMessages, settings);

    // 重新估算：新事实追加到 memories 列表
    const newMemories = inserted?.length ? [...memories, ...inserted] : memories;
    // 用第一条事实的 compressed_message_ids 来过滤（所有事实共享同一批被压消息的 ID）
    const compressedIds = inserted?.[0]?.compressed_message_ids || [];
    const remainingMessages = compressedIds.length
      ? visibleMessages.filter(m => !compressedIds.includes(m.id))
      : visibleMessages;
    const newTotal = estimateContextTokens(settings.system_prompt, newMemories, remainingMessages);

    return {
      compressed: !!inserted?.length,
      totalTokens: newTotal,
      threshold,
      newFacts: inserted?.length || 0,
    };
  } catch (err) {
    console.error('[Memory] compressIfNeeded 异常:', err.message);
    return { compressed: false, error: err.message };
  }
}

/**
 * 日历层级压缩：把旧事实合并为日摘要 → 周摘要 → 月摘要
 *
 * 每天运行一次（在凌晨低峰期）：
 *   1. 找出 7 天前、fact_type='fact' 的独立事实
 *   2. 按天分组
 *   3. 每组 ≥ 3 条时，调便宜模型合并为一条日摘要
 *   4. 日摘要存为 fact_type='daily_summary'，原事实标记 invisible
 *
 * 后续可扩展为周/月摘要（日摘要 → 周摘要，周摘要 → 月摘要）
 */
async function compressCalendarLevel(level = 'daily') {
  try {
    const allMemories = await getMemories();

    // 按 fact_type 过滤
    if (level === 'daily') {
      const facts = allMemories.filter(m => m.fact_type === 'fact');
      if (facts.length < 10) {
        console.log('[Memory] 日历压缩：独立事实不足 10 条，跳过');
        return { level, skipped: true, reason: 'not_enough_facts' };
      }

      // 按创建日期分组
      const byDay = {};
      for (const f of facts) {
        const day = new Date(f.created_at).toISOString().slice(0, 10); // YYYY-MM-DD
        if (!byDay[day]) byDay[day] = [];
        byDay[day].push(f);
      }

      // 只压缩 7 天前的
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const oldDays = Object.keys(byDay).filter(d => d < sevenDaysAgo);

      if (oldDays.length === 0) {
        console.log('[Memory] 日历压缩：无 7 天前的事实，跳过');
        return { level, skipped: true, reason: 'no_old_facts' };
      }

      let totalCompressed = 0;
      for (const day of oldDays) {
        const dayFacts = byDay[day];
        if (dayFacts.length < 3) continue;

        // 用便宜模型把当天事实合并为一条日摘要
        const factTexts = dayFacts.map(f => f.summary).join('\n');
        const { callModel } = require('./ai');
        const result = await callModel(
          [{ role: 'user', content: factTexts }],
          'deepseek-chat',
          { temperature: 0.3, max_response_tokens: 400 },
          `请将以下${day}的记忆事实合并为一条简短的日摘要（50-150字）。保留重要事件和情感变化，用第三人称。`
        );

        const dailySummary = result.content?.trim();
        if (!dailySummary || dailySummary.length < 10) continue;

        // 尝试生成 embedding
        let embedding = null;
        try {
          const emb = await getEmbedding(dailySummary);
          if (emb) embedding = emb;
        } catch (e) { /* 无 embedding 也可存 */ }

        // 存日摘要
        await insertMemory(dailySummary, [], {
          embedding,
          factType: 'daily_summary',
          heat: Math.max(...dayFacts.map(f => f.heat || 1.0)), // 继承最高热度
        });

        // 删除原始事实（已被日摘要替代）
        const factIds = dayFacts.map(f => f.id);
        await deleteMemories(factIds);

        totalCompressed += dayFacts.length;
        console.log(`[Memory] 日历压缩 ${day}：${dayFacts.length} 条事实 → 1 条日摘要`);
      }

      console.log(`[Memory] 日历压缩完成：${totalCompressed} 条事实已合并为日摘要`);
      return { level, compressed: totalCompressed, days: oldDays.length };
    }

    // TODO: 周摘要（daily_summary → weekly_summary）
    // TODO: 月摘要（weekly_summary → monthly_summary）

    return { level, skipped: true, reason: 'level_not_implemented' };
  } catch (err) {
    console.error('[Memory] 日历压缩失败:', err.message);
    return { level, skipped: true, error: err.message };
  }
}

module.exports = {
  groupIntoRounds,
  estimateContextTokens,
  maybeCompress,
  compressIfNeeded,
  searchRelevantMemories,
  compressCalendarLevel,
};
