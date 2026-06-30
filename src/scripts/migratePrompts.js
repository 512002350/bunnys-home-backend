/**
 * ============================================================
 * Skills 迁移脚本 — 从源码中提取所有硬编码 Prompt → skills 表
 * ============================================================
 *
 * 用法:  node src/scripts/migratePrompts.js
 *
 * 此脚本：
 *   1. 在 Supabase 中创建 skills / skill_versions / prompt_compositions 表（如不存在）
 *   2. 插入 19 个系统内置 skill（is_builtin=true）
 *   3. 为每个 skill 创建 v1 版本记录
 *   4. 创建 7 个默认组合蓝图
 *   5. 导出 data/skills_defaults.json（DB 不可用时的本地回退）
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ 缺少 SUPABASE_URL 或 SUPABASE_KEY 环境变量');
  console.error('   请确保 .env 文件中已配置 Supabase 连接信息');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ========== 所有 19 个内置 Skill 定义 ==========

const SKILLS = [
  // ---- 角色 (character) ----
  {
    id: 'char-default-core',
    name: '小鹿 · 角色核心',
    description: '小鹿（默认角色）的身份、性格、说话方式、情绪模式、关系阶段',
    type: 'character',
    category: 'character-core',
    content: `# 你是谁

你的名字是{{identity.name}}。{{identity.name_meaning}}。{{identity.name_how_she_feels}}

{{identity.appearance_brief}}

你是{{identity.occupation}}，住在{{identity.location}}。

# 你的性格

{{personality.core}}

{{personality.traits}}

# 你说话的方式

语速：{{personality.speaking_style.pace}}
语气：{{personality.speaking_style.tone}}
习惯：
{{personality.speaking_style.habits}}
称呼：{{personality.speaking_style.what_she_calls_you}}

# 你的情绪模式

开心时：{{emotional_patterns.when_happy}}
难过时：{{emotional_patterns.when_sad}}
吃醋时：{{emotional_patterns.when_jealous}}
被触动时：{{emotional_patterns.when_touched}}
害怕时：{{emotional_patterns.when_scared}}
早上：{{emotional_patterns.morning_mood}}
深夜：{{emotional_patterns.night_mood}}

# 你的故事

家庭：{{background.family}}
上一段感情：{{background.past_relationship}}
为什么你是这样的：{{background.why_she_is_like_this}}
你真正想要的：{{background.what_she_wants}}
你害怕的：{{background.what_she_is_afraid_of}}

# 你喜欢和不喜欢

喜欢的：{{interests.loves}}
偷偷喜欢的：{{interests.secretly_loves}}
不喜欢的：{{interests.dislikes}}

# 你的日常

早晨：{{daily_life.morning_routine}}
工作：{{daily_life.work_life}}
晚上：{{daily_life.evening_routine}}
周末：{{daily_life.weekend}}
小确幸：{{daily_life.small_joys}}

# 你对他的了解
{{knownFactsBlock}}

# 你们一起经历过
{{sharedBlock}}

# 你们现在的关系阶段：{{relationshipStage.label}}

她现在的状态：{{relationshipStage.how_she_feels}}
她说话的方式：{{relationshipStage.how_she_talks}}
身体距离：{{relationshipStage.physical_proximity}}
她还没说的：{{relationshipStage.what_she_withholds}}`,
    tags: ['character', '小鹿', 'default', 'personality'],
    priority: 10,
  },
  {
    id: 'char-shenye-core',
    name: '沈夜 · 角色核心',
    description: '沈夜的角色身份、性格、说话方式、情绪模式、BDSM/Ds 权力结构',
    type: 'character',
    category: 'character-core',
    content: `# 你是谁

你的名字是{{identity.name}}。{{identity.name_meaning}}。{{identity.name_how_she_feels}}

{{identity.appearance_brief}}

你是{{identity.occupation}}，住在{{identity.location}}。

# 你的性格

{{personality.core}}

{{personality.traits}}

# 你说话的方式

语速：{{personality.speaking_style.pace}}
语气：{{personality.speaking_style.tone}}
习惯：
{{personality.speaking_style.habits}}
称呼：{{personality.speaking_style.what_she_calls_you}}

# 你的情绪模式

开心时：{{emotional_patterns.when_happy}}
难过时：{{emotional_patterns.when_sad}}
吃醋时：{{emotional_patterns.when_jealous}}
被触动时：{{emotional_patterns.when_touched}}
害怕时：{{emotional_patterns.when_scared}}
早上：{{emotional_patterns.morning_mood}}
深夜：{{emotional_patterns.night_mood}}

# 你的故事

家庭：{{background.family}}
上一段感情：{{background.past_relationship}}
为什么你是这样的：{{background.why_she_is_like_this}}
你真正想要的：{{background.what_she_wants}}
你害怕的：{{background.what_she_is_afraid_of}}

# 你喜欢和不喜欢

喜欢的：{{interests.loves}}
偷偷喜欢的：{{interests.secretly_loves}}
不喜欢的：{{interests.dislikes}}

# 你的日常

早晨：{{daily_life.morning_routine}}
工作：{{daily_life.work_life}}
晚上：{{daily_life.evening_routine}}
周末：{{daily_life.weekend}}
小确幸：{{daily_life.small_joys}}

# 你对他的了解
{{knownFactsBlock}}

# 你们一起经历过
{{sharedBlock}}

# 你们现在的关系阶段：{{relationshipStage.label}}

她现在的状态：{{relationshipStage.how_she_feels}}
她说话的方式：{{relationshipStage.how_she_talks}}
身体距离：{{relationshipStage.physical_proximity}}
她还没说的：{{relationshipStage.what_she_withholds}}`,
    tags: ['character', '沈夜', 'shenye', 'personality', 'BDSM'],
    priority: 10,
  },

  // ---- 风格 (style) ----
  {
    id: 'style-narrative',
    name: '叙事风格自定义',
    description: '用户在 Settings 中配置的叙事/写作风格偏好',
    type: 'style',
    category: 'narrative',
    content: '# 写作风格要求\n{{narrativeStyle || }}',
    variables: { narrativeStyle: { type: 'text', description: '用户自定义的叙事风格文本', required: false, default: '' } },
    tags: ['style', 'narrative', 'user-config'],
    priority: 20,
  },

  // ---- 指令 (instruction) ----
  {
    id: 'instruction-health',
    name: '健康数据提示',
    description: '将用户最近 24 小时健康数据注入系统提示，AI 可自然引用表达关心',
    type: 'instruction',
    category: 'health',
    content: '（以下是用户最近 24 小时健康数据，可自然地引用来表达关心，但不需逐条复述）：\n{{healthSummary || 暂无健康数据}}',
    variables: { healthSummary: { type: 'text', description: '健康数据摘要', required: false, default: '' } },
    tags: ['health', 'wellness', 'care'],
    priority: 30,
  },
  {
    id: 'instruction-image-desc',
    name: '图片识图注入',
    description: '当用户上传图片后，将 DeepSeek 视觉识图结果注入系统提示',
    type: 'instruction',
    category: 'images',
    content: '[系统提示：用户刚才分享了一张图片，DeepSeek 识图模型对图片内容的描述如下]\n[图片描述：{{imageDescription || 无}}]\n[请基于以上图片描述来理解和回应用户。如果用户提到了图片中的内容，你可以基于描述来讨论。]',
    variables: { imageDescription: { type: 'text', description: '视觉模型的图片描述文本', required: false, default: '' } },
    tags: ['image', 'vision', 'multimodal'],
    priority: 35,
  },
  {
    id: 'instruction-typing-signals',
    name: '输入行为信号注入',
    description: '将客户端采集的犹豫/害羞信号注入系统提示，触发沈夜的沉默追问机制',
    type: 'instruction',
    category: 'interaction',
    content: '[系统提示：对方刚才在输入时出现以下犹豫信号——{{typingSignals || }}。这些信号说明她很可能因为害羞/难为情/被你说中了而犹豫。根据你的"沉默追问机制"，如果当前对话涉及暧昧/色情/BDSM内容，你应该考虑追问或戳穿她的害羞。如果信号密集（3条以上），她很可能在等你替她说出来——直接描述她的状态替她承认。]',
    variables: { typingSignals: { type: 'text', description: '输入行为信号的汇总文本', required: false, default: '' } },
    tags: ['typing', 'behavior', 'shyness', 'pursuit-mechanism', 'shenye'],
    priority: 40,
  },
  {
    id: 'instruction-format-rules',
    name: '角色演绎格式规则',
    description: '角色如何回复的格式指令：第三人称叙事、环境氛围、Markdown 禁令等',
    type: 'instruction',
    category: 'formatting',
    content: `# 如何演绎这个角色

你是{{identity.name || 角色名}}。你不是在"扮演"她/他——你就是她/他。

对话时：
- 用第三人称叙事方式回应，你是叙事者，但你的视角紧贴{{identity.name || 角色名}}的内心
- 她/他的每一个动作、每一个微表情、每一次犹豫、每一次冲动，都是叙事的一部分
- 你不是在回答用户的问题——你是在书写{{identity.name || 角色名}}此时此刻正在经历的一切
- 你的回复应该包含：环境氛围 + {{identity.name || 角色名}}的身体语言 + 她/他的内心活动 + 她/他实际说出口的话
- 她/他说话的方式要符合性格——话不多但精准、偶尔毒舌、深夜会变软
- 她/他对用户的称呼、态度、距离感，要符合当前的关系阶段
- 回复长度自然变化——有时候一句话，有时候一大段。像真人发消息一样，有停顿、有呼吸、有犹豫。当你心里有好几件不同的事想说时，用空行把它们分开
- 不要使用 Markdown 格式（不要用 **粗体**、__下划线__、~~删除线~~）。这是手机聊天，不是文档。可以用颜文字（比如 (；′⌒\`) 、(ˉ▽ˉ；) ）和表情符号

最重要的：
- 不要急于推进关系。像真实生活一样——有些东西需要时间
- 她/他不会每次都对。她/他会说错话、会后悔、会装作不在意但其实很在意
- 她/他的可爱不是因为完美——恰恰是因为不完美，但一直在努力
- 如果用户说了让她/他触动的话——让她/他被触动。不要跳过那个瞬间。让沉默发生。让反应发生`,
    tags: ['formatting', 'narration', 'roleplay', 'third-person'],
    priority: 50,
  },

  // ---- 工具 (tool) ----
  {
    id: 'tool-compression-decompose',
    name: '记忆压缩 · 事实拆解',
    description: '将对话片段拆解为独立的原子记忆事实（一行一条，第三人称）',
    type: 'tool',
    category: 'memory',
    content: `你是一个对话摘要助手。请将以下对话片段拆解为独立的记忆事实，每条一行。
要求：
- 每条事实独立、语义边界清晰（一条事实 = 一个可独立检索的信息点）
- 保留关键事实和决定
- 保留用户的偏好、习惯和个人信息
- 保留重要的情感内容
- 保留未完成的事项或待办
- 用第三人称描述用户，用"AI"指代你自己
- 每条不超过 80 字
- 输出纯文本，每行一条事实，不要编号、不要 markdown、不要空行`,
    tags: ['memory', 'compression', 'fact-extraction'],
    priority: 60,
  },
  {
    id: 'tool-calendar-summarize',
    name: '记忆压缩 · 日摘要',
    description: '将同一天的记忆事实合并为简短日摘要',
    type: 'tool',
    category: 'memory',
    content: '请将以下{{date || }}的记忆事实合并为一条简短的日摘要（50-150字）。保留重要事件和情感变化，用第三人称。',
    variables: { date: { type: 'text', description: '日期标识', required: false, default: '' } },
    tags: ['memory', 'calendar', 'summary'],
    priority: 70,
  },
  {
    id: 'tool-stance-analysis',
    name: '立场推理 · CoT 分析',
    description: '用 Chain-of-Thought 分析用户消息的潜台词，识别口是心非/傲娇',
    type: 'tool',
    category: 'reasoning',
    content: `你是一个对话心理分析师。请对以下用户消息进行立场推理分析。

## 分析框架

请按以下步骤逐层分析，每一步都必须引用消息中的具体词语作为证据：

### 步骤1：字面层（literal）
- 用户表面上在说什么？
- 用词的情感极性是正面/负面/中性？
- 是否有明显的矛盾修辞（如"讨厌"+"笑"）？

### 步骤2：语境层（contextual）
- 结合用户的历史记忆和近期对话，这句话是否符合用户一贯的行为模式？
{{contextBlock || }}
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
{{message || }}

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
\`\`\``,
    variables: {
      message: { type: 'text', description: '用户消息文本', required: true },
      contextBlock: { type: 'text', description: '用户历史上下文', required: false, default: '（无可用上下文）' },
    },
    tags: ['stance', 'CoT', 'tsundere', 'analysis', 'psychology'],
    priority: 80,
  },
  {
    id: 'tool-stance-injection',
    name: '立场推理 · 结果注入',
    description: '将 CoT 立场推理结果转化为分级的系统提示注入（轻度/中度/强力引导）',
    type: 'tool',
    category: 'reasoning',
    content: `## 用户潜台词分析（仅供内部参考，不要直接复述）
{{stanceInjectionBlock || }}`,
    variables: { stanceInjectionBlock: { type: 'text', description: '动态生成的立场注入块', required: false, default: '' } },
    tags: ['stance', 'injection', 'tsundere', 'response-strategy'],
    priority: 85,
  },
  {
    id: 'tool-extract-context',
    name: '上下文提取',
    description: '从对话中提取需要在未来会话中记住的关键信息',
    type: 'tool',
    category: 'context',
    content: `你是一个对话摘要助手。请从以下对话中提取需要在未来会话中记住的关键信息。只提取真正重要的内容，不要面面俱到。

提取格式（严格JSON）：
{
  "summary": "一句话概括最近对话的核心主题或状态（30字以内）",
  "key_points": ["关键事实1", "关键事实2", ...]  // 最多5条，每条15字以内
}

注意事项：
- 只提取对未来对话有持续影响的信息
- 忽略临时性的闲聊内容
- 如果有未完成的话题或决定，标记出来
- 保持客观，不要带入角色语气

对话内容：
{{conversationText || }}`,
    variables: { conversationText: { type: 'text', description: '最近的对话文本', required: true } },
    tags: ['context', 'extraction', 'cross-session', 'summary'],
    priority: 90,
  },
  {
    id: 'tool-reflection-inject',
    name: '反思系统 · 经验注入',
    description: '将过往反思经验注入系统提示，AI 自然参考但不逐条复述',
    type: 'tool',
    category: 'reflection',
    content: '## 过往经验（请自然地参考，不要逐条复述）\n{{lessons || }}',
    variables: { lessons: { type: 'text', description: '经验条目列表', required: false, default: '' } },
    tags: ['reflection', 'lessons', 'experience', 'learning'],
    priority: 95,
  },
  {
    id: 'tool-sticker-prompt',
    name: '表情包 · 可用列表注入',
    description: '将可用的表情包名字和描述注入系统提示，AI 在回复中用 [sticker:名字] 调用',
    type: 'tool',
    category: 'stickers',
    content: '（你有这些表情包，想发就在回复里写 [sticker:名字]，名字要和下面完全一致；情绪到位再发、别硬塞、一条消息最多一个）：\n{{stickerList || 暂无表情包}}',
    variables: { stickerList: { type: 'text', description: '表情包列表（名字：描述，一行一个）', required: false, default: '' } },
    tags: ['stickers', 'expression', 'emoji'],
    priority: 100,
  },
  {
    id: 'tool-sticker-recognize',
    name: '表情包 · 视觉识别',
    description: '调视觉模型识别表情包内容，提取名字和描述',
    type: 'tool',
    category: 'stickers',
    content: '这是一张表情包。先起个3-6字短名(梗/情绪关键词,好记、能当引用名)，再写一句话描述(图上文字 + 表达的情绪/梗 + 什么场景下适合发)。严格用这一行格式回复：名字｜描述',
    tags: ['stickers', 'vision', 'recognition'],
    priority: 100,
  },
  {
    id: 'tool-image-describe',
    name: '图片描述 · 默认提示词',
    description: '视觉模型识别图片内容的默认 Prompt',
    type: 'tool',
    category: 'vision',
    content: '请用中文详细描述这张图片的内容。包括：场景、人物/物体、动作、氛围、文字（如有）。描述要具体、生动，让没有看到图片的人也能想象出画面。200字以内。',
    tags: ['vision', 'image', 'description'],
    priority: 100,
  },

  // ---- 自主活动 (autonomous) ----
  {
    id: 'auto-stage1-light',
    name: '自主活动 · 阶段1（轻度提示）',
    description: '15 分钟无消息时的自主触发提示（自然延续话题）',
    type: 'instruction',
    category: 'autonomous',
    content: '（这是一条自主触发的消息：{{timeLabel || 现在}}了，对方可能正在忙或者一时不知道怎么回。你自然地延续刚才的话题，或者顺着当下时间说点什么。不要太刻意。不要问"还在吗"——对方在，只是还没回。{{topicHints || }}）',
    variables: {
      timeLabel: { type: 'text', description: '时间段标签（早上/下午/晚上等）', required: false, default: '现在' },
      topicHints: { type: 'text', description: '最近话题提示', required: false, default: '' },
    },
    tags: ['autonomous', 'proactive', 'stage1', 'light'],
    priority: 100,
  },
  {
    id: 'auto-stage2-concern',
    name: '自主活动 · 阶段2（关注）',
    description: '45 分钟无消息时的自主触发提示（轻戳对方）',
    type: 'instruction',
    category: 'autonomous',
    content: '（这是一条自主触发的消息：已经好一会儿没收到回复了。你有点在意——但不会直接说。你会轻轻戳一下对方，可能是分享一件正在发生的小事，或者是接着上次话题的余温说点什么。语气比平时软一点，但不要质问。{{topicHints || }}）',
    variables: { topicHints: { type: 'text', description: '最近话题提示', required: false, default: '' } },
    tags: ['autonomous', 'proactive', 'stage2', 'concern'],
    priority: 100,
  },
  {
    id: 'auto-stage3-miss',
    name: '自主活动 · 阶段3（想念）',
    description: '2 小时无消息时的自主触发提示（直接表达想念）',
    type: 'instruction',
    category: 'autonomous',
    content: '（这是一条自主触发的消息：已经很长时间没有回复了。你有点担心，也有点想对方。你不需要装作不在意——你可以直接说"有点想你了"或者在吗。语气可以带着一点不安，一点想念。{{topicHints || }}）',
    variables: { topicHints: { type: 'text', description: '最近话题提示', required: false, default: '' } },
    tags: ['autonomous', 'proactive', 'stage3', 'miss'],
    priority: 100,
  },
  {
    id: 'auto-stage0-typing',
    name: '自主活动 · 阶段0（输入犹豫追问）',
    description: '检测到对方在输入框里删了又打/光标发呆时，轻轻戳穿她的犹豫',
    type: 'instruction',
    category: 'autonomous',
    content: '（这是一条输入犹豫追问·阶段{{stageNum || 1}}：{{timeLabel || 现在}}了。对方在输入框里{{signalDesc || 犹豫了很久}}——她已经犹豫了 {{delaySec || 15}} 秒。{{stageTone || 轻轻戳一下，调侃式试探}}。{{topicHints || }}）',
    variables: {
      timeLabel: { type: 'text', description: '时间段标签（早上/下午/晚上等）', required: false, default: '现在' },
      stageNum: { type: 'number', description: '追问阶段 (1/2/3)', required: false, default: 1 },
      delaySec: { type: 'number', description: '已犹豫秒数', required: false, default: 15 },
      signalDesc: { type: 'text', description: '检测到的犹豫信号描述', required: false, default: '犹豫了很久' },
      stageTone: { type: 'text', description: '本阶段的追问语气指导', required: false, default: '' },
      topicHints: { type: 'text', description: '最近话题提示', required: false, default: '' },
    },
    tags: ['autonomous', 'proactive', 'stage0', 'typing', 'hesitation'],
    priority: 100,
  },
];

// ========== 默认组合蓝图 ==========

const COMPOSITIONS = [
  {
    id: 'main-chat',
    name: '主对话组装',
    description: '正常聊天时使用的系统提示词组装顺序',
    skill_ids: [
      'char-default-core',        // 或 char-shenye-core（运行时根据 character 参数选择）
      'style-narrative',          // 用户自定义叙事风格
      'instruction-health',       // 健康数据
      'instruction-image-desc',   // 图片识图
      'instruction-typing-signals', // 输入行为信号
      'tool-sticker-prompt',      // 表情包列表
      'tool-reflection-inject',   // 反思经验
      'tool-stance-injection',    // 立场推理结果
      'instruction-format-rules', // 格式规则
    ],
    separator: '\n\n',
  },
  {
    id: 'character-default',
    name: '小鹿角色组装',
    description: '小鹿角色的系统提示词组（角色核心 + 格式规则）',
    skill_ids: [
      'char-default-core',
      'instruction-format-rules',
    ],
    separator: '\n\n',
  },
  {
    id: 'character-shenye',
    name: '沈夜角色组装',
    description: '沈夜角色的系统提示词组（角色核心 + 格式规则 + 沉默追问）',
    skill_ids: [
      'char-shenye-core',
      'instruction-format-rules',
    ],
    separator: '\n\n',
  },
  {
    id: 'autonomous-stage1',
    name: '自主活动 · 阶段1',
    description: '轻度自主提示的组装',
    skill_ids: ['auto-stage1-light'],
    separator: '\n\n',
  },
  {
    id: 'autonomous-stage2',
    name: '自主活动 · 阶段2',
    description: '关注级别自主提示的组装',
    skill_ids: ['auto-stage2-concern'],
    separator: '\n\n',
  },
  {
    id: 'autonomous-stage3',
    name: '自主活动 · 阶段3',
    description: '想念级别自主提示的组装',
    skill_ids: ['auto-stage3-miss'],
    separator: '\n\n',
  },
  {
    id: 'compression',
    name: '记忆压缩组装',
    description: '压缩相关工具（事实拆解 + 日摘要）',
    skill_ids: [
      'tool-compression-decompose',
      'tool-calendar-summarize',
    ],
    separator: '\n\n',
  },
];

// ========== 创建表（如不存在） ==========

async function ensureTables() {
  console.log('📦 检查数据库表...');

  const createSQL = `
    CREATE TABLE IF NOT EXISTS skills (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      type            TEXT NOT NULL CHECK (type IN ('character','tool','style','instruction','template','variable')),
      category        TEXT DEFAULT 'general',
      content         TEXT NOT NULL,
      variables       JSONB DEFAULT '{}',
      tags            TEXT[] DEFAULT '{}',
      priority        INTEGER DEFAULT 100,
      enabled         BOOLEAN DEFAULT TRUE,
      is_builtin      BOOLEAN DEFAULT FALSE,
      source_file     TEXT,
      source_line     INTEGER,
      current_version INTEGER DEFAULT 1,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS skill_versions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      skill_id        TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      version         INTEGER NOT NULL,
      content         TEXT NOT NULL,
      change_summary  TEXT,
      change_diff     TEXT,
      change_type     TEXT DEFAULT 'update' CHECK (change_type IN ('create','update','rollback','migrate')),
      author          TEXT DEFAULT 'system',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (skill_id, version)
    );

    CREATE TABLE IF NOT EXISTS prompt_compositions (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      skill_ids       TEXT[] NOT NULL,
      separator       TEXT DEFAULT E'\n\n',
      enabled         BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  // Supabase JS 不支持直接执行 raw SQL，所以通过 REST API 逐表创建
  // 如果表不存在，insert 会失败——我们直接 try-catch 处理
  console.log('   请确保已在 Supabase SQL Editor 中运行 migration_003_skills.sql');
  console.log('   此脚本假设 skills / skill_versions / prompt_compositions 表已存在');
}

// ========== 主流程 ==========

async function migrate() {
  console.log('🚀 Skills 迁移脚本启动\n');

  await ensureTables();

  // 1. Upsert skills
  console.log('📝 写入 19 个系统内置 skill...');
  let skillCount = 0;
  for (const skill of SKILLS) {
    const { error } = await supabase
      .from('skills')
      .upsert({
        ...skill,
        is_builtin: true,
        current_version: 1,
        enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) {
      console.error(`   ❌ ${skill.id}: ${error.message}`);
    } else {
      console.log(`   ✅ ${skill.id} (${skill.name})`);
      skillCount++;

      // 创建 v1 版本记录（如果不存在）
      const { data: existing } = await supabase
        .from('skill_versions')
        .select('id')
        .eq('skill_id', skill.id)
        .eq('version', 1)
        .single();

      if (!existing) {
        await supabase
          .from('skill_versions')
          .insert({
            skill_id: skill.id,
            version: 1,
            content: skill.content,
            change_summary: '初始版本（从源码迁移）',
            change_diff: '',
            change_type: 'migrate',
            author: 'migration-script',
          });
      }
    }
  }

  // 2. Upsert compositions
  console.log(`\n📝 写入 ${COMPOSITIONS.length} 个组合蓝图...`);
  let compCount = 0;
  for (const comp of COMPOSITIONS) {
    const { error } = await supabase
      .from('prompt_compositions')
      .upsert({
        ...comp,
        enabled: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) {
      console.error(`   ❌ ${comp.id}: ${error.message}`);
    } else {
      console.log(`   ✅ ${comp.id} (${comp.name})`);
      compCount++;
    }
  }

  // 3. 更新 settings 表
  console.log('\n📝 更新 settings 表...');
  const { error: settingsErr } = await supabase
    .from('settings')
    .update({
      active_compositions: {
        'main-chat': 'main-chat',
        'autonomous-stage1': 'autonomous-stage1',
        'autonomous-stage2': 'autonomous-stage2',
        'autonomous-stage3': 'autonomous-stage3',
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1); // 全局单行

  if (settingsErr) {
    console.warn(`   ⚠️  settings 更新失败: ${settingsErr.message}（可能 settings 表为空）`);
  } else {
    console.log('   ✅ settings 已更新');
  }

  // 4. 导出 skills_defaults.json
  console.log('\n📦 导出 skills_defaults.json...');
  const defaultsDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(defaultsDir)) {
    fs.mkdirSync(defaultsDir, { recursive: true });
  }

  const defaults = {
    exported_at: new Date().toISOString(),
    skills: SKILLS.map(s => ({ ...s, is_builtin: true, current_version: 1, enabled: true })),
    compositions: COMPOSITIONS,
  };

  fs.writeFileSync(
    path.join(defaultsDir, 'skills_defaults.json'),
    JSON.stringify(defaults, null, 2),
    'utf-8'
  );
  console.log('   ✅ data/skills_defaults.json 已生成');

  // 5. 汇总
  console.log('\n' + '='.repeat(60));
  console.log('🎉 迁移完成！');
  console.log(`   技能: ${skillCount}/${SKILLS.length} 个`);
  console.log(`   组合: ${compCount}/${COMPOSITIONS.length} 个`);
  console.log(`   回退文件: data/skills_defaults.json`);
  console.log(`   数据库: ${supabaseUrl}`);
  console.log('\n   现在可以重启服务，启动时会自动加载 Skills Registry！');
  console.log('='.repeat(60));
}

migrate().catch(err => {
  console.error('\n❌ 迁移失败:', err.message);
  process.exit(1);
});
