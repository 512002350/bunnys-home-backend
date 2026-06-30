/**
 * 定时任务调度器 — 从 index.js 抽取，统一管理所有后台定时任务
 */

const { pullAndStore } = require('./huaweiHealth');
const { decayAllMemories } = require('./supabase');
const { compressCalendarLevel } = require('./memory');

// ========== 配置（环境变量可覆盖） ==========
const PULL_INTERVAL = parseInt(process.env.HEALTH_PULL_INTERVAL_MS) || 30 * 60 * 1000;
const PULL_DELAY = parseInt(process.env.HEALTH_PULL_DELAY_MS) || 10000;
const DECAY_INTERVAL = parseInt(process.env.MEMORY_DECAY_INTERVAL_MS) || 60 * 60 * 1000;
const DECAY_DELAY = parseInt(process.env.MEMORY_DECAY_DELAY_MS) || 30000;
const DECAY_RATE = parseFloat(process.env.MEMORY_DECAY_RATE) || 0.95;
const CALENDAR_INTERVAL = parseInt(process.env.CALENDAR_COMPRESS_INTERVAL_MS) || 24 * 60 * 60 * 1000;
const CALENDAR_DELAY = parseInt(process.env.CALENDAR_COMPRESS_DELAY_MS) || 2 * 60 * 60 * 1000;
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL_MS) || 10 * 60 * 1000;

/**
 * 启动所有定时任务
 */
function startAll() {
  // 华为 Health Kit 数据拉取
  if (process.env.HUAWEI_APP_ID) {
    setTimeout(() => {
      pullAndStore().catch(err => console.warn('[Scheduler] 健康数据拉取失败:', err.message));
      setInterval(() => pullAndStore().catch(err => console.warn('[Scheduler] 健康数据拉取失败:', err.message)), PULL_INTERVAL);
    }, PULL_DELAY);
  }

  // 记忆热度衰减
  setTimeout(() => {
    decayAllMemories(DECAY_RATE).catch(err => console.warn('[Scheduler] 记忆衰减失败:', err.message));
    setInterval(() => decayAllMemories(DECAY_RATE).catch(err => console.warn('[Scheduler] 记忆衰减失败:', err.message)), DECAY_INTERVAL);
  }, DECAY_DELAY);

  // 日历层级压缩
  setTimeout(() => {
    compressCalendarLevel('daily').catch(err => console.warn('[Scheduler] 日历压缩失败:', err.message));
    setInterval(() => compressCalendarLevel('daily').catch(err => console.warn('[Scheduler] 日历压缩失败:', err.message)), CALENDAR_INTERVAL);
  }, CALENDAR_DELAY);

  // 自保活 ping（防止 Render 免费版休眠）
  const hostname = process.env.RENDER_EXTERNAL_HOSTNAME;
  const selfUrl = hostname
    ? `https://${hostname}`
    : (process.env.SELF_URL || `http://localhost:${process.env.PORT || 3000}`);
  setInterval(async () => {
    try {
      await fetch(`${selfUrl}/api/health`);
    } catch (_) { /* 间歇性网络问题是正常的 */ }
  }, KEEPALIVE_INTERVAL);
  console.log(`🫀 自保活已启用：每 ${KEEPALIVE_INTERVAL / 60000} 分钟 ping ${selfUrl}/api/health`);
}

module.exports = { startAll };
