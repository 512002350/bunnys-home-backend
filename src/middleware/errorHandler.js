/**
 * 统一错误处理中间件
 */
function errorHandler(err, req, res, _next) {
  console.error(`[Error] ${req.method} ${req.path}:`, err.message);

  // Supabase 错误
  if (err.code && err.code.startsWith('P')) {
    return res.status(500).json({
      error: '数据库错误',
      detail: err.message,
    });
  }

  // 模型 API 错误
  if (err.message.includes('模型 API') || err.message.includes('API')) {
    return res.status(502).json({
      error: '模型服务错误',
      detail: err.message,
    });
  }

  res.status(err.status || 500).json({
    error: err.message || '服务器内部错误',
  });
}

module.exports = errorHandler;
