/**
 * 图片视觉识别服务
 *
 * 使用 DeepSeek / OpenRouter Vision API 对图片进行中文描述
 * 供聊天图片上传和表情包上传共用
 */

/**
 * 调用视觉 API 描述图片内容
 * 优先使用 OpenRouter（模型选择多），DeepSeek 直连作为备选
 * @param {string} base64Image - 图片的 base64 编码（不含 data: 前缀）
 * @param {string} mimeType - 图片 MIME 类型，默认 'image/jpeg'
 * @param {string} [customPrompt] - 可选的自定义提示词
 * @returns {Promise<string>} 中文图片描述
 */
async function describeImage(base64Image, mimeType = 'image/jpeg', customPrompt = '') {
  // 确保有 data: 前缀
  const dataUrl = base64Image.startsWith('data:')
    ? base64Image
    : `data:${mimeType};base64,${base64Image}`;

  const defaultPrompt = '请用中文详细描述这张图片的内容。包括：场景、人物/物体、动作、氛围、文字（如有）。描述要具体、生动，让没有看到图片的人也能想象出画面。200字以内。';
  const prompt = customPrompt || defaultPrompt;

  // 策略1: 通过 OpenRouter 调用视觉模型
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await callOpenRouterVision(dataUrl, prompt);
    } catch (err) {
      console.log('[ImageVision] OpenRouter 视觉调用失败:', err.message);
    }
  }

  throw new Error('所有视觉模型调用均失败，请检查 OPENROUTER_API_KEY 配置');
}

/**
 * 通过 OpenRouter 调用视觉模型
 */
async function callOpenRouterVision(dataUrl, prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

  // 按优先级尝试多个视觉模型（ID 来源于 OpenRouter /models 接口）
  const models = [
    'nvidia/nemotron-nano-12b-v2-vl:free', // 免费，速度快
    'qwen/qwen3-vl-8b-instruct',           // 通义千问3 VL 8B（轻量，中文友好）
    'google/gemini-2.5-flash',              // Gemini 2.5 Flash（便宜好用）
    'meta-llama/llama-3.2-11b-vision-instruct', // Llama 视觉
    'qwen/qwen2.5-vl-72b-instruct',        // 通义千问2.5 VL 72B（中文母语）
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
        const errText = await response.text();
        console.log(`[ImageVision] ${model} 返回 ${response.status}, 尝试下一个...`);
        lastError = new Error(`${model}: ${response.status} ${errText}`);
        continue;
      }

      const data = await response.json();
      const description = data.choices?.[0]?.message?.content?.trim() || '';
      if (description) {
        console.log(`[ImageVision] ${model} 识别成功 (${description.length} 字符)`);
        return description;
      }
      lastError = new Error(`${model}: 返回空内容`);
    } catch (err) {
      console.log(`[ImageVision] ${model} 网络错误:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('OpenRouter 所有视觉模型均不可用');
}

module.exports = { describeImage };
