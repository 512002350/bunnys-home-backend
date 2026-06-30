/**
 * 图片视觉识别服务
 *
 * 优先级回退链（2025.07 更新）:
 *   1. 豆包 (Doubao) — 火山引擎 Ark 直连，地标识别最强，中文优秀
 *   2. 通义千问 (Qwen-VL) — DashScope 直连，中文母语，性价比最高
 *   3. Gemini — Google AI Studio 直连（免费 tier，准确率高但国内需代理）
 *   4. OpenRouter — 代理多种视觉模型（最终回退）
 *
 * 聊天图片上传和表情包上传共用
 */

const skills = require('./skills');

/**
 * 调用视觉 API 描述图片内容
 * 优先级: 豆包 → 千问 → Gemini → OpenRouter 多模型回退
 */
async function describeImage(base64Image, mimeType = 'image/jpeg', customPrompt = '') {
  const dataUrl = base64Image.startsWith('data:')
    ? base64Image
    : `data:${mimeType};base64,${base64Image}`;

  const defaultPrompt = await skills.resolve('tool-image-describe').catch(() =>
    '请用中文详细描述这张图片的内容。包括：场景、人物/物体、动作、氛围、文字（如有）。描述要具体、生动，让没有看到图片的人也能想象出画面。200字以内。');
  const prompt = customPrompt || defaultPrompt;

  // 1. 豆包直连（火山引擎 Ark）— 地标识别最强
  if (process.env.DOUBAO_API_KEY) {
    try {
      return await callDoubaoVision(dataUrl, prompt);
    } catch (err) {
      console.log('[ImageVision] 豆包视觉调用失败:', err.message);
    }
  }

  // 2. 千问直连（DashScope）
  if (process.env.DASHSCOPE_API_KEY) {
    try {
      return await callQwenVision(dataUrl, prompt);
    } catch (err) {
      console.log('[ImageVision] 千问视觉调用失败:', err.message);
    }
  }

  // 3. Gemini 直连（Google AI Studio）
  if (process.env.GEMINI_API_KEY) {
    try {
      return await callGeminiVision(base64Image, mimeType, prompt);
    } catch (err) {
      console.log('[ImageVision] Gemini 视觉调用失败:', err.message);
    }
  }

  // 4. OpenRouter 多模型回退（原有逻辑）
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await callOpenRouterVision(dataUrl, prompt);
    } catch (err) {
      console.log('[ImageVision] OpenRouter 视觉调用失败:', err.message);
    }
  }

  throw new Error('所有视觉模型调用均失败，请检查 API Key 配置（DASHSCOPE_API_KEY / DOUBAO_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY）');
}

// ========== Provider 实现 ==========

/**
 * 通义千问 (Qwen-VL) — 阿里云 DashScope
 * 模型: qwen-vl-max（qwen-vl-plus 更便宜，效果接近）
 * API: https://help.aliyun.com/zh/dashscope/developer-reference/tongyi-qianwen-vl-plus-api
 */
async function callQwenVision(dataUrl, prompt) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const model = process.env.QWEN_VISION_MODEL || 'qwen-vl-max';
  const baseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt },
      ],
    }],
    max_tokens: 600,
    temperature: 0.3,
  };

  return callProviderAPI(`${baseURL}/chat/completions`, apiKey, body, '千问(Qwen-VL)');
}

/**
 * 豆包 (Doubao) — 字节跳动火山引擎 Ark
 * 模型: doubao-seed-2-0-pro-260215
 * API: https://www.volcengine.com/docs/82379/1569618
 */
async function callDoubaoVision(dataUrl, prompt) {
  const apiKey = process.env.DOUBAO_API_KEY;
  const model = process.env.DOUBAO_VISION_MODEL || 'doubao-seed-2-0-pro-260215';
  const baseURL = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt },
      ],
    }],
    max_tokens: 600,
    temperature: 0.3,
  };

  return callProviderAPI(`${baseURL}/chat/completions`, apiKey, body, '豆包(Doubao)');
}

/**
 * Gemini — Google AI Studio 直连
 * 模型: gemini-2.5-flash（超高性价比，MMBench 89.3 分）
 * API: https://ai.google.dev/gemini-api/docs/vision
 */
async function callGeminiVision(base64Image, mimeType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
  const baseURL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

  const url = `${baseURL}/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64Image } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: 600,
      temperature: 0.3,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const description = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  if (description) {
    console.log(`[ImageVision] Gemini(gemini-2.5-flash) 识别成功 (${description.length} 字符)`);
    return description;
  }
  throw new Error('Gemini: 返回空内容');
}

/**
 * 通用 OpenAI-compatible API 调用（千问/豆包 共用）
 */
async function callProviderAPI(url, apiKey, body, label) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${label}: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const description = data.choices?.[0]?.message?.content?.trim() || '';
  if (description) {
    console.log(`[ImageVision] ${label} 识别成功 (${description.length} 字符)`);
    return description;
  }
  throw new Error(`${label}: 返回空内容`);
}

/**
 * OpenRouter 多模型回退（原有逻辑保留）
 */
async function callOpenRouterVision(dataUrl, prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

  const models = [
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'qwen/qwen3-vl-8b-instruct',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3.2-11b-vision-instruct',
    'qwen/qwen2.5-vl-72b-instruct',
  ];

  let lastError = null;
  for (const model of models) {
    try {
      const body = {
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens: 600,
        temperature: 0.3,
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
        console.log(`[ImageVision] OpenRouter ${model} 返回 ${response.status}, 尝试下一个...`);
        lastError = new Error(`${model}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const description = data.choices?.[0]?.message?.content?.trim() || '';
      if (description) {
        console.log(`[ImageVision] OpenRouter ${model} 识别成功 (${description.length} 字符)`);
        return description;
      }
      lastError = new Error(`${model}: 返回空内容`);
    } catch (err) {
      console.log(`[ImageVision] OpenRouter ${model} 网络错误:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('OpenRouter 所有视觉模型均不可用');
}

module.exports = { describeImage };
