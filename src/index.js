require('dotenv').config();

const express = require('express');
const cors = require('cors');
const errorHandler = require('./middleware/errorHandler');

const chatRoutes = require('./routes/chat');
const sessionsRoutes = require('./routes/sessions');
const settingsRoutes = require('./routes/settings');
const healthRoutes = require('./routes/health');
// sticker 路由已合并到 chat.js 中（/api/stickers）

const app = express();
const PORT = process.env.PORT || 3000;

// ---- 中间件 ----
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' })); // 支持 base64 图片上传

// ---- 路由 ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', chatRoutes);      // /api/chat, /api/stickers
app.use('/api/sessions', sessionsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/health', healthRoutes);  // /api/health/update, /api/health/latest

// ---- 错误处理 ----
app.use(errorHandler);

// ---- 定时拉取华为 Health Kit 健康数据（每 30 分钟） ----
const { pullAndStore } = require('./services/huaweiHealth');
const PULL_INTERVAL = 30 * 60 * 1000;

setTimeout(() => {
  pullAndStore().catch(() => {});
  setInterval(() => pullAndStore().catch(() => {}), PULL_INTERVAL);
}, 10000);

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`🐰 Bunny's Home 后端已启动 → http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/api/health`);
  if (process.env.HUAWEI_APP_ID) {
    console.log('🫀 华为 Health Kit 自动拉取已启用（每 30 分钟）');
  } else {
    console.log('🫀 华为 Health Kit 未配置，访问 /api/health/huawei/auth 开始授权');
  }
  if (!process.env.OPENROUTER_API_KEY && !process.env.CLAUDE_API_KEY) {
    console.warn('⚠️  未配置模型 API Key，对话接口将无法工作');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.warn('⚠️  未配置 Supabase 环境变量，数据库功能将无法工作');
  }
});
