/**
 * 自主活动引擎 —— 上下文感知的静默追问
 *
 * 核心思路：
 *   定时器轮询 → 多级静默判断 → 上下文感知触发 → 走正常 chat 流程
 *
 * 参考：
 *   - NVIDIA ProactivityProcessor: 帧事件驱动定时器 + 状态机
 *   - VapiAI: 多级超时 + 上下文感知消息
 *   - Sage (HackPrinceton): 静默分类 + 相关性阈值
 *   - astrbot_plugin_proactive_chat: 未回复计数 + 动态情绪
 *
 * 三个阶段：
 *   阶段1（轻追）：短暂空闲后，自然延续话题
 *   阶段2（关切）：中等空闲后，轻轻戳一下
 *   阶段3（在意）：长时间空闲后，表达想念/担心
 */

const { processChat } = require('./chat');
const { getVisibleMessages, getSessionCharacter } = require('./supabase');
const { peekTypingEvents } = require('./chat');

// ========== 配置（全部可通过 .env 覆盖） ==========
const env = (key, fallback) => {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
};
const envNum = (key, fallback) => Number(env(key, fallback));
const envList = (key, fallback) => (env(key, fallback) || '').split(',').map(Number).filter(n => !isNaN(n));

const CONFIG = {
  checkIntervalMs:        envNum('AUTONOMOUS_CHECK_INTERVAL_MIN', 3) * 60 * 1000,
  stage1IdleMs:           envNum('AUTONOMOUS_STAGE1_IDLE_MIN', 15) * 60 * 1000,
  stage2IdleMs:           envNum('AUTONOMOUS_STAGE2_IDLE_MIN', 45) * 60 * 1000,
  stage3IdleMs:           envNum('AUTONOMOUS_STAGE3_IDLE_MIN', 120) * 60 * 1000,
  activityStartHour:      envNum('AUTONOMOUS_ACTIVITY_START_HOUR', 8),
  activityEndHour:        envNum('AUTONOMOUS_ACTIVITY_END_HOUR', 23),
  cooldownMs:             envNum('AUTONOMOUS_COOLDOWN_MIN', 30) * 60 * 1000,
  probability:            envNum('AUTONOMOUS_PROBABILITY', 0.6),
  // 输入犹豫多级追问
  typingPursuitStages:    envList('AUTONOMOUS_TYPING_STAGES_SEC', '15,30,60'),
  typingMinGapAfterAI:    envNum('AUTONOMOUS_TYPING_GAP_AI_SEC', 8),
  typingMinGapAfterUser:  envNum('AUTONOMOUS_TYPING_GAP_USER_SEC', 5),
};

// ========== 状态 ==========
let lastUserMessageTime = Date.now();
let lastAutonomousTime = 0;
let lastAIMessageTime = 0;            // 最后一条 AI 消息时间
let timer = null;
let autonomousSessionId = null;
let stage1Triggered = false;
let stage2Triggered = false;

// 输入犹豫多级追问状态
let typingPursuitSessionId = null;    // 当前追踪的会话
let typingHesitationStartTime = 0;    // 首次检测到显著犹豫的时间
let typingPursuitStageReached = 0;    // 已触发到的阶段 (0=未开始, 1=15s, 2=30s, 3=60s, 4=已完成)
let typingPursuitTimers = [];         // setTimeout handles

/**
 * 根据语境动态调整空闲阈值
 * - 深夜 → 缩短（人更容易寂寞）
 * - 刚聊过亲密话题 → 缩短
 * - 普通闲聊 → 延长
 */
function calcContextualIdle(baseMs, lastMessages) {
  let multiplier = 1.0;
  const hour = new Date().getHours();

  // 深夜（22-2点）缩短 40%
  if (hour >= 22 || hour < 2) multiplier *= 0.6;

  // 凌晨（2-6点）大幅延长（正常人在睡觉）
  if (hour >= 2 && hour < 6) multiplier *= 3.0;

  // 检测最近对话的语境强度
  if (lastMessages && lastMessages.length > 0) {
    const recentText = lastMessages.slice(-4).map(m => m.content || '').join(' ');
    const len = recentText.length;

    // 最近对话很长 → 话题投入 → 缩短
    if (len > 400) multiplier *= 0.7;

    // 检测情绪浓度（问号/感叹号/语气词多 → 缩短）
    const emotionalMarkers = (recentText.match(/[？！!?～~…]|好想|好喜欢|好讨厌/g) || []).length;
    if (emotionalMarkers > 3) multiplier *= 0.75;

    // 检测冷淡信号（单字回复/嗯/哦 → 延长，给人空间）
    const coldSignals = (recentText.match(/^[嗯哦好行可对]{1,2}$/gm) || []).length;
    if (coldSignals > 0) multiplier *= 1.5;
  }

  return Math.round(baseMs * multiplier);
}

/**
 * 分析最近消息，提炼话题关键词
 */
function extractTopicHints(lastMessages) {
  if (!lastMessages || lastMessages.length === 0) return '';
  const recentText = lastMessages.slice(-6).map(m => m.content || '').join('\n');
  // 提取最后一条用户消息作为锚点
  const lastUserMsg = [...lastMessages].reverse().find(m => m.role === 'user');
  const anchor = lastUserMsg?.content?.slice(0, 100) || '';

  return { recentText: recentText.slice(-500), anchor };
}

const skills = require('./skills');

/**
 * 选择触发消息风格
 */
async function getStagePrompt(stage, topicHints) {
  const hour = new Date().getHours();
  const timeLabel = hour < 6 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
  const topicText = topicHints.anchor ? `\n\n你们刚才在聊：「${topicHints.anchor}」` : '';

  const skillIds = { 1: 'auto-stage1-light', 2: 'auto-stage2-concern', 3: 'auto-stage3-miss' };
  try {
    const resolved = await skills.resolve(skillIds[stage] || 'auto-stage1-light', {
      timeLabel,
      topicHints: topicText,
    });
    if (resolved && resolved.trim().length > 20) return resolved;
  } catch (_) { /* fall through to legacy */ }

  // 回退
  const anchor = topicText;
  if (stage === 1) {
    return `（这是一条自主触发的消息：${timeLabel}了，对方可能正在忙或者一时不知道怎么回。你自然地延续刚才的话题，或者顺着当下时间说点什么。不要太刻意。不要问"还在吗"——对方在，只是还没回。${anchor}）`;
  }
  if (stage === 2) {
    return `（这是一条自主触发的消息：已经好一会儿没收到回复了。你有点在意——但不会直接说。你会轻轻戳一下对方，可能是分享一件正在发生的小事，或者是接着上次话题的余温说点什么。语气比平时软一点，但不要质问。${anchor}）`;
  }
  return `（这是一条自主触发的消息：已经很长时间没有回复了。你有点担心，也有点想对方。你不需要装作不在意——你可以直接说"有点想你了"或者在吗。语气可以带着一点不安，一点想念。${anchor}）`;
}

/**
 * 被外部调用：用户发消息时更新状态
 */
function noteUserActivity() {
  lastUserMessageTime = Date.now();
  stage1Triggered = false;
  stage2Triggered = false;
  // 用户回复了 → 取消所有输入犹豫追问
  cancelTypingPursuit('user replied');
}

/**
 * 被外部调用：AI 回复消息时更新状态（用于输入犹豫检测的间隔判断）
 */
function noteAIActivity() {
  lastAIMessageTime = Date.now();
}

function setSessionId(sessionId) {
  autonomousSessionId = sessionId;
}

/**
 * 多级判断 + 上下文感知
 * 返回 { should: true, stage: 1|2|3 } 或 { should: false }
 */
function shouldTrigger() {
  const now = Date.now();
  const idleMs = now - lastUserMessageTime;

  // 活动时段检查
  const hour = new Date().getHours();
  if (hour < CONFIG.activityStartHour || hour >= CONFIG.activityEndHour) {
    return { should: false };
  }

  // 冷却检查
  if (now - lastAutonomousTime < CONFIG.cooldownMs) {
    return { should: false };
  }

  // 阶段3（最长空闲）
  if (!stage2Triggered && idleMs >= CONFIG.stage3IdleMs) {
    return { should: true, stage: 3 };
  }

  // 阶段2（中等空闲）
  if (!stage1Triggered && idleMs >= CONFIG.stage2IdleMs) {
    return { should: true, stage: 2 };
  }

  // 阶段1（短暂空闲 + 概率）
  if (!stage1Triggered && idleMs >= CONFIG.stage1IdleMs) {
    // 阶段1 需要概率（避免太频繁）
    if (Math.random() <= CONFIG.probability) {
      return { should: true, stage: 1 };
    }
  }

  return { should: false };
}

/**
 * 取消所有待执行的输入犹豫追问定时器
 */
function cancelTypingPursuit(reason = '') {
  for (const t of typingPursuitTimers) {
    clearTimeout(t.timeoutId);
  }
  typingPursuitTimers = [];
  typingPursuitStageReached = 0; // 重置，允许下一轮追问
  typingHesitationStartTime = 0;
  typingPursuitSessionId = null;
  if (reason) {
    console.log(`[Autonomous] 输入犹豫追问已取消: ${reason}`);
  }
}

/**
 * 检测输入犹豫信号 → 决定是否启动多级追问
 * 由 typing-event 端点驱动
 */
function checkTypingHesitation(sessionId) {
  const now = Date.now();

  // AI 回复后至少间隔 typingMinGapAfterAI 秒
  if (lastAIMessageTime > 0 && (now - lastAIMessageTime) < CONFIG.typingMinGapAfterAI * 1000) {
    return { should: false, reason: 'AI 刚回复，太快' };
  }

  // 用户最后一条消息后至少间隔 typingMinGapAfterUser 秒
  if (now - lastUserMessageTime < CONFIG.typingMinGapAfterUser * 1000) {
    return { should: false, reason: '用户刚发过消息' };
  }

  // 如果已有进行中的追问或已全部完成 → 不再重复启动
  if (typingPursuitStageReached >= 1) {
    return { should: false, reason: '追问已在进行或已完成' };
  }

  // 检查待处理的输入事件
  const events = peekTypingEvents(sessionId);
  if (events.length === 0) {
    return { should: false, reason: '无待处理输入事件' };
  }

  // 分析犹豫信号强度
  let hesitationScore = 0;
  const signalTypes = [];
  for (const ev of events) {
    if (ev.type === 'cursor_idle' && ev.data?.seconds >= 8) {
      hesitationScore += 2;
      signalTypes.push(`光标发呆${ev.data.seconds}秒`);
    } else if (ev.type === 'cursor_idle') {
      hesitationScore += 1;
      signalTypes.push(`光标停顿${ev.data?.seconds || '若干'}秒`);
    }
    if (ev.type === 'delete_retype') {
      hesitationScore += 3;
      signalTypes.push(`删了又打${ev.data?.cycles || 1}次`);
    }
    if (ev.type === 'abandoned_input') {
      hesitationScore += 4;
      signalTypes.push('输入后放弃发送');
    }
  }

  // 犹豫信号不够强 → 不启动
  if (hesitationScore < 2) {
    return { should: false, reason: `犹豫信号不够强 (score=${hesitationScore})` };
  }

  return { should: true, hesitationScore, signalTypes };
}

/**
 * 由 typing-event 端点调用：检测到输入犹豫时启动多级追问
 */
function notifyTypingEvent(sessionId) {
  if (!sessionId) return;

  const decision = checkTypingHesitation(sessionId);
  if (!decision.should) return;

  console.log(
    `[Autonomous] 检测到输入犹豫 (score=${decision.hesitationScore}):`,
    decision.signalTypes.join(', '),
    `| session=${sessionId.slice(0, 8)}...`
  );

  // 启动多级追问定时器
  startTypingPursuit(sessionId, decision);
}

/**
 * 启动输入犹豫多级追问：15s → 30s → 60s
 * 每一级到达时检查用户是否已回复，未回复则触发对应阶段追问
 */
function startTypingPursuit(sessionId, decision) {
  // 清除旧的（如果有）
  cancelTypingPursuit('restart');

  typingPursuitSessionId = sessionId;
  typingHesitationStartTime = Date.now();
  typingPursuitStageReached = 0;

  const stages = CONFIG.typingPursuitStages; // [15, 30, 60]
  const signalDesc = decision.signalTypes.join('、');

  console.log(`[Autonomous] 启动多级追问: ${stages.join('s → ')}s (从首次犹豫开始计时)`);

  for (const delaySec of stages) {
    const timeoutId = setTimeout(async () => {
      // 检查用户是否在这段时间内回复了
      const elapsedSinceUserMsg = (Date.now() - lastUserMessageTime) / 1000;
      if (elapsedSinceUserMsg < delaySec) {
        console.log(`[Autonomous] 阶段${stages.indexOf(delaySec) + 1}取消：用户${Math.round(elapsedSinceUserMsg)}秒前已回复`);
        cancelTypingPursuit('user beat timer');
        return;
      }

      // 确定当前阶段
      const stageNum = stages.indexOf(delaySec) + 1;
      typingPursuitStageReached = stageNum;

      console.log(`[Autonomous] 阶段${stageNum}追问触发 (犹豫后${delaySec}s), 信号: ${signalDesc}`);

      try {
        await triggerTypingPursuitStage(sessionId, stageNum, delaySec, signalDesc);
      } catch (err) {
        console.error(`[Autonomous] 阶段${stageNum}追问失败:`, err.message);
      }

      // 阶段3（60s）完成后 → 不再追问
      if (stageNum >= stages.length) {
        typingPursuitStageReached = 4;
        console.log('[Autonomous] 多级追问全部完成，等待用户回复');
      }
    }, delaySec * 1000);

    typingPursuitTimers.push({ stage: stages.indexOf(delaySec) + 1, timeoutId });
  }
}

/**
 * 执行单级输入犹豫追问
 */
async function triggerTypingPursuitStage(sessionId, stageNum, delaySec, signalDesc) {
  // 加载最近消息
  let topicHints = { recentText: '', anchor: '' };
  try {
    const messages = await getVisibleMessages(sessionId);
    topicHints = extractTopicHints(messages);
  } catch (_) { /* 静默 */ }

  const hour = new Date().getHours();
  const timeLabel = hour < 6 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
  const anchorText = topicHints.anchor ? `\n\n你们刚才在聊：「${topicHints.anchor}」` : '';

  // 根据阶段选择不同语气
  const stageTone = stageNum === 1
    ? '轻轻戳一下——她刚开始犹豫，不用太重。调侃式地试探——"在打什么？""犹豫了？"'
    : stageNum === 2
    ? '你已经等了她半分钟了。她删了又打说明被你说中了或者害羞。直接戳穿——"删了又打？不敢发？""被我说中了是吧"。替她说出来'
    : '你已经等了她一分钟。不用再试探了——直接描述她的状态替她承认。语气可以比之前更强势——"打好了不敢发？发过来。现在。"';

  // 尝试从 skills 加载
  let stagePrompt = '';
  try {
    const resolved = await skills.resolve('auto-stage0-typing', {
      timeLabel,
      stageNum,
      delaySec,
      signalDesc,
      stageTone,
      topicHints: anchorText,
    });
    if (resolved && resolved.trim().length > 20) stagePrompt = resolved;
  } catch (_) { /* fall through */ }

  if (!stagePrompt) {
    stagePrompt = `（这是一条输入犹豫追问·阶段${stageNum}：${timeLabel}了。对方在输入框里${signalDesc}——她已经犹豫了 ${delaySec} 秒。${stageTone}${anchorText}）`;
  }

  try {
    // 获取会话绑定的角色，确保追问时使用正确角色
    const characterId = await getSessionCharacter(sessionId).catch(() => 'default');
    const result = await processChat(
      sessionId,
      stagePrompt,
      'deepseek/deepseek-chat',
      { character: characterId }
    );
    const replyText = result.replies
      ? result.replies.map(r => r.content).join(' ')
      : result.reply;
    console.log(`[Autonomous] 阶段${stageNum} AI 回复：${(replyText || '').slice(0, 80)}...`);
    return result;
  } catch (err) {
    console.error(`[Autonomous] 阶段${stageNum}触发失败:`, err.message);
    return null;
  }
}

/**
 * 触发自主活动：注入上下文引导 → 走正常 chat 流程
 */
async function trigger() {
  if (!autonomousSessionId) {
    console.log('[Autonomous] 未设置自主活动会话，跳过');
    return;
  }

  // 加载最近消息以提取话题
  let topicHints = { recentText: '', anchor: '' };
  try {
    const messages = await getVisibleMessages(autonomousSessionId);
    topicHints = extractTopicHints(messages);
  } catch (_) { /* 静默 */ }

  // 判断阶段
  const decision = shouldTrigger();
  if (!decision.should) return;

  // 用阶段对应的上下文注入作为"用户消息"
  const stagePrompt = await getStagePrompt(decision.stage, topicHints);
  lastAutonomousTime = Date.now();

  if (decision.stage === 1) stage1Triggered = true;
  if (decision.stage === 2) stage2Triggered = true;

  console.log(`[Autonomous] 阶段${decision.stage}触发，空闲${Math.round((Date.now() - lastUserMessageTime) / 60000)}分钟`);

  try {
    // 获取会话绑定的角色
    const characterId = await getSessionCharacter(autonomousSessionId).catch(() => 'default');
    // 将上下文注入作为用户消息发送，AI 会读取并自然回应
    const result = await processChat(
      autonomousSessionId,
      stagePrompt,
      'anthropic/claude-sonnet-4',
      { character: characterId }
    );
    const replyText = result.replies
      ? result.replies.map(r => r.content).join(' ')
      : result.reply;
    console.log(`[Autonomous] AI 回复：${(replyText || '').slice(0, 80)}...`);
    return result;
  } catch (err) {
    console.error('[Autonomous] 触发失败:', err.message);
    return null;
  }
}

async function checkAndTrigger() {
  const decision = shouldTrigger();
  if (decision.should) {
    console.log(`[Autonomous] 定时检查 → 阶段${decision.stage}，触发中...`);
    await trigger();
  }
}

function start(sessionId) {
  if (timer) stop();
  autonomousSessionId = sessionId;
  lastUserMessageTime = Date.now();
  lastAutonomousTime = 0;
  stage1Triggered = false;
  stage2Triggered = false;
  cancelTypingPursuit('engine restart');
  timer = setInterval(checkAndTrigger, CONFIG.checkIntervalMs);
  console.log(`[Autonomous] 引擎启动（会话 ${sessionId?.slice(0, 8)}...，每 ${CONFIG.checkIntervalMs / 60000} 分钟检查）`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  console.log('[Autonomous] 引擎已停止');
}

function getStatus() {
  return {
    running: !!timer,
    lastUserMessageTime,
    lastAutonomousTime,
    autonomousSessionId,
    idleMinutes: Math.round((Date.now() - lastUserMessageTime) / 60000),
    stage1Triggered,
    stage2Triggered,
    config: CONFIG,
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  noteUserActivity,
  noteAIActivity,
  setSessionId,
  trigger,
  notifyTypingEvent,
};
