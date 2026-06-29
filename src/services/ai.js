/**
 * AI 模型路由 —— 统一不同模型厂商的接口差异
 *
 * 支持的模型：
 *   - OpenRouter 代理的 Claude/其他模型（OpenAI 兼容格式）
 *   - 直连 Anthropic API（x-api-key 认证）
 *   - DeepSeek（OpenAI 兼容格式，用于记忆压缩）
 */

// 简单 token 估算：中文约 1.5 字符/token，英文约 4 字符/token
function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/**
 * 调用 AI 模型
 * @param {Array} messages - 消息列表 [{role, content}]
 * @param {string} model - 模型标识
 * @param {object} settings - 系统设置
 * @param {string} systemPrompt - 系统提示词
 * @param {Array} memorySummaries - 记忆摘要列表
 */
async function callModel(messages, model, settings, systemPrompt = '', memorySummaries = []) {
  // 组装系统提示词
  let fullSystemPrompt = systemPrompt || settings.system_prompt || '';

  // 注入记忆摘要
  if (memorySummaries.length > 0) {
    const memoryText = memorySummaries
      .map((m, i) => `[记忆片段 ${i + 1}]\n${m.summary}`)
      .join('\n\n');
    fullSystemPrompt = `${fullSystemPrompt}\n\n## 关于你们之前的对话（摘要）\n${memoryText}\n\n请基于以上记忆自然地融入对话，不要逐条复述。`;
  }

  // 根据模型选择调用方式
  const provider = getProvider(model);

  if (provider === 'anthropic') {
    return callAnthropicAPI(messages, fullSystemPrompt, settings, model);
  }

  // DeepSeek 直连
  if (provider === 'deepseek') {
    return callDeepSeekAPI(messages, fullSystemPrompt, settings);
  }

  // 默认走 OpenAI 兼容格式（OpenRouter、DeepSeek 等）
  return callOpenAICompatibleAPI(messages, fullSystemPrompt, settings, model);
}

function getProvider(model) {
  // DeepSeek 直连
  if (model.startsWith('deepseek')) return 'deepseek';
  // Anthropic 原生
  if (model.startsWith('claude-') && !process.env.OPENROUTER_API_KEY) return 'anthropic';
  // 默认走 OpenAI 兼容（OpenRouter）
  return 'openai-compatible';
}

/**
 * OpenAI 兼容格式（OpenRouter / DeepSeek / 大多数中转服务）
 */
async function callOpenAICompatibleAPI(messages, systemPrompt, settings, model) {
  const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error('未配置模型 API Key（OPENROUTER_API_KEY 或 DEEPSEEK_API_KEY）');
  }

  const chatMessages = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    chatMessages.push({ role: m.role, content: m.content });
  }

  const body = {
    model: model || 'anthropic/claude-sonnet-4',
    messages: chatMessages,
    temperature: settings.temperature ?? 0.7,
    max_tokens: settings.max_response_tokens ?? 2048,
  };

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`模型 API 返回错误 ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0]?.message;

  if (!choice) {
    throw new Error(`模型返回格式异常: ${JSON.stringify(data)}`);
  }

  return {
    content: choice.content || '',
    // Claude 通过 OpenRouter 时，思考过程在 reasoning 字段
    thinking: choice.reasoning || data.choices?.[0]?.reasoning_content || null,
    model: data.model || model,
    usage: data.usage || null,
  };
}

/**
 * 直连 DeepSeek API（国内可用）
 */
async function callDeepSeekAPI(messages, systemPrompt, settings) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY');
  }

  const chatMessages = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    chatMessages.push({ role: m.role, content: m.content });
  }

  const body = {
    model: 'deepseek-chat',
    messages: chatMessages,
    temperature: settings.temperature ?? 0.7,
    max_tokens: settings.max_response_tokens ?? 2048,
  };

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API 返回错误 ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0]?.message;

  return {
    content: choice?.content || '',
    thinking: null, // DeepSeek 不支持 thinking
    model: data.model || 'deepseek-chat',
    usage: data.usage || null,
  };
}

/**
 * 直连 Anthropic API
 */
async function callAnthropicAPI(messages, systemPrompt, settings, model) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 CLAUDE_API_KEY');
  }

  const body = {
    model: model || 'claude-sonnet-4-20250514',
    max_tokens: settings.max_response_tokens ?? 2048,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API 返回错误 ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  const thinkingBlock = data.content?.find(b => b.type === 'thinking');

  return {
    content: textBlock?.text || '',
    thinking: thinkingBlock?.thinking || null,
    model: data.model || model,
    usage: data.usage || null,
  };
}

module.exports = {
  callModel,
  estimateTokens,
  estimateMessagesTokens,
};
