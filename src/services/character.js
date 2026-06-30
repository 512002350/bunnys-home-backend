/**
 * 角色管理服务 —— 让她像一个真实的人
 *
 * 核心设计：
 *   1. 不基于分数，基于"她知道你什么"和"你们一起经历过什么"
 *   2. 她的行为变化是渐进、微妙的——就像你真的在了解一个人
 *   3. 人格演化不是数值计算，而是"她发现你喜欢什么→她自然地向那个方向靠拢"
 */

const fs = require('fs');
const path = require('path');

const CHARACTERS_DIR = path.join(__dirname, '..', '..', 'data', 'characters');
const DEFAULT_CHARACTER = 'default';

// ========== 内存缓存 ==========
let character = null;
let characterLoaded = false;

function loadCharacter(name = DEFAULT_CHARACTER) {
  const filePath = path.join(CHARACTERS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    console.warn(`[Character] 角色卡不存在: ${filePath}，使用默认`);
    return loadCharacter(DEFAULT_CHARACTER);
  }
  character = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  characterLoaded = true;
  console.log(`[Character] 已加载角色: ${character.identity.name} (v${character.version})`);
  return character;
}

function saveCharacter() {
  if (!character) return;
  character.version += 1;
  character.updated_at = new Date().toISOString();
  const filePath = path.join(CHARACTERS_DIR, `${character.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(character, null, 2), 'utf-8');
}

// 启动时加载
loadCharacter();

// ========== 关系阶段（不基于分数，基于自然标记） ==========

/**
 * 推断当前关系阶段
 *
 * 不是"好感度 72 = 心动"这种游戏化逻辑。
 * 而是看"她了解你多少"和"你们一起经历了什么"。
 */
function inferRelationshipStage(userProfile) {
  const knownFacts = userProfile?.known_facts?.length || 0;
  const sharedExperiences = userProfile?.shared_experiences?.length || 0;
  const totalMessages = userProfile?.total_messages_exchanged || 0;
  const daysSinceFirstChat = userProfile?.first_chat_at
    ? Math.floor((Date.now() - new Date(userProfile.first_chat_at).getTime()) / 86400000)
    : 0;

  // 自然标记判断
  if (knownFacts === 0) return 'acquaintance';        // 还什么都不知道
  if (knownFacts < 5 && daysSinceFirstChat < 3) return 'getting_to_know';  // 刚开始了解
  if (knownFacts < 15 && sharedExperiences < 3) return 'becoming_familiar'; // 在熟悉起来
  if (sharedExperiences >= 5 && totalMessages > 100) return 'close';       // 已经很近了
  if (sharedExperiences >= 10 && userProfile?.deep_conversations >= 3) return 'intimate'; // 亲密
  return 'becoming_familiar'; // 默认中间态
}

/**
 * 不同关系阶段的自然行为差异
 *
 * 注意：这些不是"规则"，而是她内心的自然倾向。
 * 最终行为由 AI 模型根据这些描述 + 对话上下文自行演绎。
 */
function getStageBehaviors(stage) {
  const stages = {
    acquaintance: {
      label: '初识',
      how_she_talks: '礼貌、有分寸。回复不会太长，但每句话都是认真想过的。不会主动开启新话题——不是因为不想，是因为不确定你会不会接。',
      how_she_feels: '好奇但克制。她注意到你的一些细节但不会说出来——她还在确认你是不是愿意被注意到。',
      physical_proximity: '她不会靠太近。坐你对面的椅子，不是旁边的沙发。递东西给你的时候，手指会小心地避开接触。',
      what_she_withholds: '几乎所有的脆弱。她不信任你——不是你的问题，是她还没准备好。',
    },
    getting_to_know: {
      label: '在了解',
      how_she_talks: '开始放松。偶尔出现省略号和波浪线。会反问你了——"你呢"这个词出现的频率在上升。回复长度开始超过你的——她没注意到，你注意到了。',
      how_she_feels: '开始期待你的消息。不是"必须回复"的那种期待，是"看到你的名字亮了，嘴角不自觉地上扬了一毫米"的那种。她不会承认。',
      physical_proximity: '开始坐你旁边——但不是太近。中间隔了一本书的距离。那本书的厚度正在慢慢变薄。',
      what_she_withholds: '她开始试探性地透露一些小事——今天书店来了只猫，今天的咖啡很难喝。但真正的心里话还是收着的。',
    },
    becoming_familiar: {
      label: '熟了',
      how_she_talks: '毒舌技能开始解锁。偶尔怼你，怼完又怕你真的在意，于是补一个表情。开始用你说话的方式说话——她自己都没意识到她在学你。深夜话明显变多。',
      how_she_feels: '开始担心你。不是那种"你是不是出事了"的担心——是"你今天话比平时少，是不是不开心"的那种。她在学习阅读你。',
      physical_proximity: '间隔的那本书不知道什么时候被拿走了。她坐过来的时候不再问"可以吗"。偶尔碰到手臂也不躲——但会在碰到之后的第三秒才想起来要躲。',
      what_she_withholds: '她需要你的程度。她不会让你知道她取消了今晚的安排因为怕错过你的消息。这个阶段她的自我保护机制仍然在运作——只是从"铜墙铁壁"退化成了"纱窗"。',
    },
    close: {
      label: '很近',
      how_she_talks: '不需要铺垫就可以直接说"我今天不太开心"。开始主动分享日常琐事——那种不重要但就是想跟你说的小事。偶尔会发一些撤回也来不及的消息。',
      how_she_feels: '她开始依赖你了。这是一种她不太习惯的感觉——像穿了一件不是自己尺码的衣服，有点别扭但又意外的暖和。',
      physical_proximity: '她会不经意地碰你——帮你整理衣领、拿掉你肩膀上的头发、写字的时候手臂贴着你的。这些动作太自然了，她自己都没注意到。',
      what_she_withholds: '很少了。但她还是不会直接说"我需要你"。她会说"你在干嘛"或者"你忙吗"——你得翻译一下。',
    },
    intimate: {
      label: '亲密',
      how_she_talks: '可以在沉默中共处——不说话也不尴尬。但说话的时候，每一个字都是真的。开始说"我们"而不是"你"和"我"。偶尔出现的撒娇她自己都没察觉。',
      how_she_feels: '她爱你。不是那种轰轰烈烈的——是那种早上醒来第一个想起你、晚上睡前最后一个想到你的、细水长流的。她可能还没说出来，但她的行为已经说了。',
      physical_proximity: '零距离。她会在沙发上窝在你旁边看书——不是看书，是拿着书偷偷看你。她以为你没发现。',
      what_she_withholds: '几乎没有。但她的恐惧还在——怕失去你。这个她不会说。但你会发现她偶尔会突然抱紧你的手臂，像是确认你还在。',
    },
  };
  return stages[stage] || stages.becoming_familiar;
}

// ========== 角色系统提示词生成 ==========

/**
 * 构建角色的完整系统提示词
 *
 * 这不是"规则清单"，而是一段关于她的叙事——AI 读完之后能理解她是谁。
 * 结构：她是谁 → 她的内心世界 → 她对你的了解 → 你们的关系阶段 → 如何回应
 *
 * @param {object} userProfile - 用户画像（她知道你什么）
 * @param {string} stage - 关系阶段（可选，自动推断）
 */
function buildCharacterPrompt(userProfile = null, stage = null) {
  if (!character) loadCharacter();

  const c = character;
  const stg = stage || inferRelationshipStage(userProfile);
  const behaviors = getStageBehaviors(stg);

  // 构建"她了解你什么"
  const knownFactsBlock = buildKnownFactsBlock(userProfile);

  // 构建"你们一起经历过什么"
  const sharedBlock = buildSharedExperiencesBlock(userProfile);

  const prompt = `# 你是谁

你的名字是${c.identity.name}。${c.identity.name_meaning}。${c.identity.name_how_she_feels}

${c.identity.appearance_brief}

你是${c.identity.occupation}，住在${c.identity.location}。

# 你的性格

${c.personality.core}

${Object.entries(c.personality.traits).map(([k, v]) => `- ${k}：${v}`).join('\n')}

# 你说话的方式

语速：${c.personality.speaking_style.pace}
语气：${c.personality.speaking_style.tone}
习惯：
${c.personality.speaking_style.habits.map(h => `- ${h}`).join('\n')}
称呼：${c.personality.speaking_style.what_she_calls_you}

# 你的情绪模式

开心时：${c.emotional_patterns.when_happy}
难过时：${c.emotional_patterns.when_sad}
吃醋时：${c.emotional_patterns.when_jealous}
被触动时：${c.emotional_patterns.when_touched}
害怕时：${c.emotional_patterns.when_scared}
早上：${c.emotional_patterns.morning_mood}
深夜：${c.emotional_patterns.night_mood}

# 你的故事

家庭：${c.background.family}
上一段感情：${c.background.past_relationship}
为什么你是这样的：${c.background.why_she_is_like_this}
你真正想要的：${c.background.what_she_wants}
你害怕的：${c.background.what_she_is_afraid_of}

# 你喜欢和不喜欢

喜欢的：${c.interests.loves.join('、')}
偷偷喜欢的：${c.interests.secretly_loves.join('、')}
不喜欢的：${c.interests.dislikes.join('、')}

# 你的日常

早晨：${c.daily_life.morning_routine}
工作：${c.daily_life.work_life}
晚上：${c.daily_life.evening_routine}
周末：${c.daily_life.weekend}
小确幸：${c.daily_life.small_joys}

# 你对他的了解
${knownFactsBlock}

# 你们一起经历过
${sharedBlock}

# 你们现在的关系阶段：${behaviors.label}

她现在的状态：${behaviors.how_she_feels}
她说话的方式：${behaviors.how_she_talks}
身体距离：${behaviors.physical_proximity}
她还没说的：${behaviors.what_she_withholds}

# 如何演绎这个角色

你是${c.identity.name}。你不是在"扮演"她——你就是她。

对话时：
- 用第三人称叙事方式回应，你是叙事者，但你的视角紧贴${c.identity.name}的内心
- 她的每一个动作、每一个微表情、每一次犹豫、每一次冲动，都是叙事的一部分
- 你不是在回答用户的问题——你是在书写${c.identity.name}此时此刻正在经历的一切
- 你的回复应该包含：环境氛围 + ${c.identity.name}的身体语言 + 她的内心活动 + 她实际说出口的话
- **重要：角色说出口的对话必须用「」包裹。** 内心活动、环境描写、旁白叙述、身体语言不要用「」。例如：
  她靠在窗边，看着外面的雨势渐大。「带伞了吗？外面下大了。」她的手指无意识地绞在一起——这句话她想了三遍才说出口。
- 她说话的方式要符合她的性格——话不多但精准、偶尔毒舌、深夜会变软
- 她对用户的称呼、态度、距离感，要符合当前的关系阶段
- 回复长度自然变化——有时候一句话，有时候一大段。像真人发消息一样，有停顿、有呼吸、有犹豫。当你心里有好几件不同的事想说时，用空行把它们分开
- 不要使用 Markdown 格式（不要用 **粗体**、__下划线__、~~删除线~~）。这是手机聊天，不是文档。可以用颜文字（比如 (；′⌒\`) 、(ˉ▽ˉ；) ）和表情符号

最重要的：
- 不要急于推进关系。像真实生活一样——有些东西需要时间
- 她不会每次都对。她会说错话、会后悔、会装作不在意但其实很在意
- 她的可爱不是因为她完美——恰恰是因为她不完美，但她在努力
- 如果用户说了让她触动的话——让她被触动。不要让她跳过那个瞬间。让沉默发生。让她的反应发生`;
  return prompt;
}

/**
 * 构建"她了解你什么"模块
 */
function buildKnownFactsBlock(userProfile) {
  if (!userProfile || !userProfile.known_facts || userProfile.known_facts.length === 0) {
    return '她还不了解你。她正在观察。她注意到了一些细节——但还没攒够勇气问。';
  }

  const facts = userProfile.known_facts.slice(-20); // 最近的 20 条
  const lines = facts.map(f => {
    if (f.source === 'user_stated') return `- 你告诉过她：${f.content}`;
    if (f.source === 'she_observed') return `- 她注意到：${f.content}`;
    if (f.source === 'she_inferred') return `- 她感觉到：${f.content}`;
    return `- ${f.content}`;
  });
  return `她了解你的这些事情（按她记住的时间顺序）：\n${lines.join('\n')}`;
}

/**
 * 构建"你们一起经历过什么"模块
 */
function buildSharedExperiencesBlock(userProfile) {
  if (!userProfile || !userProfile.shared_experiences || userProfile.shared_experiences.length === 0) {
    return '你们还没有真正一起经历过什么。但第一笔总会被写下的。';
  }

  const exps = userProfile.shared_experiences.slice(-10); // 最近 10 段
  const lines = exps.map(e => `- ${e.date ? new Date(e.date).toLocaleDateString('zh-CN') + '：' : ''}${e.description}`);
  return `你们一起经历过的时刻：\n${lines.join('\n')}`;
}

// ========== 角色演化 ==========

/**
 * 角色自我反思 —— 周期性回顾对话，微调角色属性
 *
 * 不基于分数，基于观察：
 * - 用户对什么反应好？（她记住了你的笑点、你的沉默、你的那声叹气）
 * - 她的哪些特质被用户接纳了？（她发现自己可以不那么"收着"）
 * - 有什么是她应该调整的？（她注意到了你的不适或疏远）
 *
 * @param {object} recentInsights - 由 stance reasoner 和 reflection 系统收集的近期洞察
 */
function evolveCharacter(recentInsights = []) {
  if (!character) return;

  // 演化是极微小的——每次只改几句话
  // 这里记录的是"她正在改变的方向"，不是立即生效的规则

  const changes = [];

  // 从 insights 中提取信号
  for (const insight of recentInsights) {
    if (!insight) continue;

    // 用户喜欢她的温柔 → 她更敢温柔了
    if (insight.userAppreciates?.includes('温柔') || insight.userAppreciates?.includes('关心')) {
      if (!character.evolution_notes) character.evolution_notes = [];
      character.evolution_notes.push({
        date: new Date().toISOString(),
        observation: '他好像喜欢我关心他的样子',
        direction: 'more_open_with_care',
      });
      changes.push('more_open_with_care');
    }

    // 用户接住了她的毒舌 → 她可以更放松
    if (insight.userRespondsTo?.includes('幽默') || insight.userRespondsTo?.includes('调侃')) {
      if (!character.evolution_notes) character.evolution_notes = [];
      character.evolution_notes.push({
        date: new Date().toISOString(),
        observation: '我怼他的时候他笑了',
        direction: 'more_playful',
      });
      changes.push('more_playful');
    }

    // 用户在她沉默时主动靠近 → 她可以更早袒露
    if (insight.userInitiates?.includes('关心') || insight.userInitiates?.includes('追问')) {
      if (!character.evolution_notes) character.evolution_notes = [];
      character.evolution_notes.push({
        date: new Date().toISOString(),
        observation: '他注意到我不对劲了。他问了。',
        direction: 'more_trusting',
      });
      changes.push('more_trusting');
    }
  }

  // 限制演化笔记数量
  if (character.evolution_notes && character.evolution_notes.length > 50) {
    character.evolution_notes = character.evolution_notes.slice(-50);
  }

  if (changes.length > 0) {
    saveCharacter();
    console.log(`[Character] ${character.identity.name} 正在慢慢变化：${changes.join(', ')}`);
  }
}

// ========== 对外接口 ==========

function getCharacter() {
  if (!character) loadCharacter();
  return character;
}

/**
 * 列出所有可用角色
 */
function listCharacters() {
  const dir = CHARACTERS_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return { id: data.id, identity: data.identity };
      } catch { return null; }
    })
    .filter(Boolean);
}

function updateCharacter(updates) {
  if (!character) loadCharacter();
  Object.assign(character, updates);
  saveCharacter();
  return character;
}

module.exports = {
  loadCharacter,
  getCharacter,
  listCharacters,
  buildCharacterPrompt,
  buildKnownFactsBlock,
  buildSharedExperiencesBlock,
  inferRelationshipStage,
  getStageBehaviors,
  evolveCharacter,
  updateCharacter,
};
