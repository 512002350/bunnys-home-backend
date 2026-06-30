/**
 * CoT 立场推理器 —— 识别"口是心非"
 *
 * 核心思路（Stance Reasoner 方案）：
 *   1. 用户消息 → 便宜模型（DeepSeek）跑链式推理
 *   2. 推理链：字面含义 → 情感极性 → 与历史行为的矛盾 → 可能的真实意图 → 置信度
 *   3. 结构化 JSON 输出
 *   4. 分析结果注入主模型的 system prompt，引导回应策略
 *
 * 参考：
 *   - Stance Reasoner (SemEval-2016, CoT-based zero-shot)
 *   - BeliefShift Benchmark (contradiction detection tracks)
 *   - CAPS 理论（场景驱动的人格属性激活）
 */

const { callModel } = require('./ai');
const { getMemories } = require('./supabase');

// 只用便宜模型做推理，不消耗主模型 token
const REASONER_MODEL = 'deepseek-chat';

/**
 * 对用户消息进行 CoT 立场推理
 *
 * @param {string} userMessage - 用户消息
 * @param {Array} recentContext - 最近几条对话（可选，用于一致性判断）
 * @param {Array} relevantMemories - 相关记忆（可选，用于历史行为对比）
 * @returns {object} 推理结果 { literal, implied, tsundereIndex, confidence, reasoning }
 */
async function analyzeStance(userMessage, recentContext = [], relevantMemories = []) {
  if (!userMessage || userMessage.trim().length < 4) {
    return null; // 太短的消息不分析
  }

  // 构建上下文摘要
  const contextBlock = buildContextBlock(recentContext, relevantMemories);

  try {
    const result = await callModel(
      [{ role: 'user', content: await buildReasoningPrompt(userMessage, contextBlock) }],
      REASONER_MODEL,
      { temperature: 0.1, max_response_tokens: 600 }, // 低温度保证一致性
      '' // system prompt 在 message 里
    );

    const parsed = parseReasoningOutput(result.content);
    if (parsed) {
      console.log(`[Stance] 推理完成：tsundere=${parsed.tsundereIndex.toFixed(2)} conf=${parsed.confidence.toFixed(2)} — ${parsed.implied?.slice(0, 60)}`);
    }
    return parsed;
  } catch (err) {
    console.error('[Stance] 推理失败:', err.message);
    return null;
  }
}

const skills = require('./skills');

/**
 * 构建推理 prompt
 *
 * 设计要点（来自论文）：
 *   - 强制 Chain-of-Thought 步骤：前提 → 推理 → 结论
 *   - 要求区分"字面义""情感义""意图义"三层
 *   - 自洽性约束：如果找不到足够证据，宁可输出低置信度
 */
async function buildReasoningPrompt(message, contextBlock) {
  const result = await skills.resolve('tool-stance-analysis', {
    message,
    contextBlock: contextBlock ? '- 提供的历史上下文：\n' + contextBlock : '（无可用上下文）',
  }).catch(() => null);

  if (result && result.trim().length > 100) return result;

  // 回退：传统硬编码 prompt
  const ctxBlock = contextBlock ? '- 提供的历史上下文：\n' + contextBlock : '- （无可用上下文）';
  return `你是一个对话心理分析师。请对以下用户消息进行立场推理分析。

## 分析框架

请按以下步骤逐层分析，每一步都必须引用消息中的具体词语作为证据：

### 步骤1：字面层（literal）
- 用户表面上在说什么？
- 用词的情感极性是正面/负面/中性？
- 是否有明显的矛盾修辞（如"讨厌"+"笑"）？

### 步骤2：语境层（contextual）
- 结合用户的历史记忆和近期对话，这句话是否符合用户一贯的行为模式？
${ctxBlock}
- 如果当前消息与用户过去的行为存在矛盾，标记为"行为不一致"

### 步骤3：意图层（intentional）
- 用户说这句话可能真正想表达什么？
- 是否存在"嘴上说不，心里想要"的模式（口是心非/傲娇）？
- 用户是否在用反向表达来试探或期待对方的主动？

### 步骤4：综合判断
- 给出傲娇指数（0-1，0=完全坦率，1=完全反向）
- 给出分析置信度（0-1）
- 如果置信度 < 0.5，说明原因

## 用户消息
${message}

## 输出格式（严格 JSON，不要额外文字）
\`\`\`json
{
  "literal": {
    "surface_meaning": "字面意思（一句话）",
    "polarity": "positive/negative/neutral/ambivalent",
    "contradiction_signals": ["发现的矛盾信号"]
  },
  "contextual": {
    "consistent_with_history": true/false/null,
    "behavioral_contradiction": "与历史行为的矛盾（如有）"
  },
  "intentional": {
    "implied_meaning": "可能的真实意图（一句话，如果不确定填'无明显潜台词'）",
    "reverse_expression": true/false,
    "hidden_need": "用户可能真正想要的是什么"
  },
  "judgment": {
    "tsundere_index": 0.0,
    "confidence": 0.0,
    "explanation": "简短解释（30字以内）",
    "response_strategy": "direct_acknowledge/nudge_gently/play_along/probe_further/ignore_ambiguity"
  }
}
\`\`\``;
}

/**
 * 构建历史上下文摘要（精简，不给推理模型太多无关信息）
 */
function buildContextBlock(recentContext, relevantMemories) {
  const parts = [];

  if (recentContext.length > 0) {
    const recent = recentContext.slice(-4); // 只取最近 4 条
    const lines = recent.map(m => {
      const role = m.role === 'user' ? '用户' : 'AI';
      return `${role}: ${(m.content || '').slice(0, 100)}`;
    });
    parts.push('【近期对话】\n' + lines.join('\n'));
  }

  if (relevantMemories.length > 0) {
    const mems = relevantMemories.slice(0, 5);
    const lines = mems.map(m => `· ${m.summary}`);
    parts.push('【用户历史偏好】\n' + lines.join('\n'));
  }

  return parts.join('\n\n');
}

/**
 * 解析模型输出的 JSON（可能包裹在 ```json 中）
 */
function parseReasoningOutput(raw) {
  if (!raw) return null;

  try {
    // 尝试提取 JSON 块
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

    const parsed = JSON.parse(jsonStr);

    // 标准化字段名（兼容模型可能的变体）
    return {
      literal: parsed.literal?.surface_meaning || parsed.literal || '',
      polarity: parsed.literal?.polarity || 'neutral',
      contradictionSignals: parsed.literal?.contradiction_signals || [],
      implied: parsed.intentional?.implied_meaning || '',
      reverseExpression: parsed.intentional?.reverse_expression || false,
      hiddenNeed: parsed.intentional?.hidden_need || '',
      tsundereIndex: typeof parsed.judgment?.tsundere_index === 'number'
        ? parsed.judgment.tsundere_index
        : (typeof parsed.judgment?.tsundereIndex === 'number' ? parsed.judgment.tsundereIndex : 0),
      confidence: typeof parsed.judgment?.confidence === 'number'
        ? parsed.judgment.confidence
        : 0.5,
      explanation: parsed.judgment?.explanation || '',
      responseStrategy: parsed.judgment?.response_strategy || 'direct_acknowledge',
      consistentWithHistory: parsed.contextual?.consistent_with_history,
      raw: parsed,
    };
  } catch (e) {
    console.error('[Stance] JSON 解析失败:', e.message, 'RAW:', raw.slice(0, 200));
    return null;
  }
}

/**
 * 将推理结果转化为注入 system prompt 的引导块
 *
 * 根据傲娇指数和置信度，生成不同级别的引导指令：
 *   - tsundere_index < 0.3：正常回应，不加引导
 *   - 0.3–0.6：轻度引导，提示 AI 注意潜在意图
 *   - 0.6–0.8：中度引导，指示 AI 以"看破不说破"的方式回应
 *   - > 0.8：强力引导，指示 AI 直接戳破但保留用户的"台阶"
 */
function toPromptBlock(stanceResult) {
  if (!stanceResult || stanceResult.confidence < 0.4) return '';

  const idx = stanceResult.tsundereIndex;
  const strategy = stanceResult.responseStrategy;

  if (idx < 0.3) return ''; // 无明显口是心非，不浪费 token

  let block = '\n\n## 用户潜台词分析（仅供内部参考，不要直接复述）\n';

  if (idx >= 0.3 && idx < 0.6) {
    block += `- 用户可能有轻微的口是心非（指数${idx.toFixed(1)}）：字面上在拒绝/否定，但真正的需求可能是"${stanceResult.hiddenNeed || '被关注/被挽留'}"`;
    block += `\n- 回应策略：${strategy === 'nudge_gently' ? '用温柔的方式轻轻推一下，给用户台阶下' : '不直接拆穿，但用行动回应潜在需求'}`;
  } else if (idx >= 0.6 && idx < 0.8) {
    block += `- 用户有明显的反向表达（指数${idx.toFixed(1)}）：表面"${(stanceResult.literal || '').slice(0, 40)}"，实际可能想表达"${(stanceResult.implied || '').slice(0, 60)}"`;
    block += `\n- 回应策略：${strategy === 'play_along' ? '配合用户的"剧本"，看破不说破，用身体语言/环境描写来回应潜台词' : '用行动而非言语来回应，给用户保留"嘴硬"的空间'}`;
  } else {
    block += `- 用户强烈反向表达（指数${idx.toFixed(1)}）：嘴上说"${(stanceResult.literal || '').slice(0, 40)}"，但内心渴望的事情是——${stanceResult.implied || stanceResult.hiddenNeed || '被主动对待'}`;
    block += `\n- 回应策略：适度戳破但保留用户的"台阶"——用"我偏要"式的温柔强势来回应`;
  }

  // 附加上下文矛盾（如果有）
  if (stanceResult.consistentWithHistory === false) {
    block += `\n- 注意：用户当前发言与历史行为模式不一致，这可能是情绪波动的信号`;
  }

  return block;
}

/**
 * 关键：根据推理结果中的 response_strategy，微调主模型的 temperature
 *
 * - direct_acknowledge：正常 temperature
 * - nudge_gently / play_along：略微提高 temperature（需要更多创造性来"迂回"回应）
 * - probe_further：略微降低 temperature（需要谨慎试探）
 */
function getTemperatureAdjustment(stanceResult) {
  if (!stanceResult || stanceResult.confidence < 0.4) return 0;

  switch (stanceResult.responseStrategy) {
    case 'nudge_gently':
    case 'play_along':
      return +0.05; // 需要一点创造性来迂回表达
    case 'probe_further':
      return -0.05; // 试探阶段需要更谨慎
    case 'ignore_ambiguity':
      return 0;
    default:
      return 0;
  }
}

module.exports = {
  analyzeStance,
  toPromptBlock,
  getTemperatureAdjustment,
};
