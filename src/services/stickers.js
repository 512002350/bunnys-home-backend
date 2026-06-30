/**
 * 表情包服务
 *
 * 上传时视觉模型看一眼写好描述 → 图片以 base64 存 DB（兼容 Vercel 无状态部署）
 * 支持本地搜索 + API盒子外部搜索
 */

const { getSupabase } = require('./supabase');
const { describeImage } = require('./imageVision');
const skills = require('./skills');

/**
 * 获取所有表情包
 */
async function getStickers() {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from('stickers')
    .select('*')
    .order('name', { ascending: true });
  if (error) {
    if (error.code === '42P01') return [];
    throw error;
  }
  return data || [];
}

/**
 * 搜索本地表情包（按名字/描述模糊匹配）
 */
async function searchStickers(query) {
  if (!query || !query.trim()) return getStickers();
  const q = query.trim();
  const db = getSupabase();
  if (!db) return [];

  // ilike 模糊搜索名字和描述
  const { data, error } = await db
    .from('stickers')
    .select('*')
    .or(`name.ilike.%${q}%,descr.ilike.%${q}%`)
    .order('name', { ascending: true })
    .limit(20);

  if (error) {
    if (error.code === '42P01') return [];
    throw error;
  }
  return data || [];
}

/**
 * API盒子 —— 中文表情包外部搜索
 * 文档: https://www.cnapihz.com
 * 环境变量 APIHEZI_ID / APIHEZI_KEY（可选，不配则不启用外源搜索）
 */
const APIHEZI_ID = process.env.APIHEZI_ID || '';
const APIHEZI_KEY = process.env.APIHEZI_KEY || '';
const APIHEZI_BASE = 'https://cn.apihz.cn/api/img/xqbbq.php';

async function searchExternalStickers(query) {
  if (!query || !query.trim()) return [];
  if (!APIHEZI_ID || !APIHEZI_KEY) return []; // 未配置则不启用

  try {
    const url = `${APIHEZI_BASE}?id=${APIHEZI_ID}&key=${APIHEZI_KEY}&type=2&words=${encodeURIComponent(query.trim())}&limit=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();

    if (json.code !== 200 || !json.res?.length) return [];

    return json.res.map((imgUrl, i) => ({
      id: `ext-${Date.now()}-${i}`,
      name: `${query}${i + 1}`,
      url: imgUrl,
      descr: `来自API盒子: ${query}`,
      external: true,
    }));
  } catch (err) {
    console.warn('[Stickers] 外部搜索失败:', err.message);
    return [];
  }
}

/**
 * 添加外部表情包到本地库
 * @param {string} imageUrl - 外部图片 URL
 * @param {string} name - 表情名
 * @param {string} descr - 描述
 */
async function addExternalSticker(imageUrl, name, descr) {
  const db = getSupabase();
  if (!db) throw new Error('数据库不可用');

  // 下载外部图片并转 base64
  let base64;
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    const buf = await res.arrayBuffer();
    const mime = res.headers.get('content-type') || 'image/png';
    base64 = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch (err) {
    throw new Error('下载外部图片失败: ' + err.message);
  }

  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '');
  const { data: sticker, error } = await db
    .from('stickers')
    .upsert({ id, name, url: base64, descr })
    .select()
    .single();

  if (error) throw error;
  return sticker;
}

/**
 * 上传表情包 —— 视觉模型自动描述 → base64 入库
 * @param {string} imageBase64 - 图片的 base64 编码（不含 data: 前缀）
 * @param {string} mimeType - 图片 MIME 类型，默认 'image/png'
 */
async function uploadSticker(imageBase64, mimeType = 'image/png') {
  const stickerPrompt = await skills.resolve('tool-sticker-recognize').catch(() =>
    '这是一张表情包。先起个3-6字短名(梗/情绪关键词,好记、能当引用名)，' +
    '再写一句话描述(图上文字 + 表达的情绪/梗 + 什么场景下适合发)。' +
    '严格用这一行格式回复：名字｜描述');

  // 1. 调视觉模型识别
  let line;
  try {
    line = await describeImage(imageBase64, mimeType, stickerPrompt);
  } catch (err) {
    throw new Error('视觉模型识别表情包失败: ' + err.message);
  }

  const separatorIdx = line.indexOf('｜');
  const name = separatorIdx > 0 ? line.slice(0, separatorIdx).trim() : line.slice(0, 6);
  const desc = separatorIdx > 0 ? line.slice(separatorIdx + 1).trim() : line;

  if (!name) {
    throw new Error('视觉模型未能识别表情包名字');
  }

  // 2. 生成 id
  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '');

  // 3. 构造 base64 data URL（直接入库，不写文件）
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  const db = getSupabase();
  if (!db) {
    return { id, name, url: dataUrl, descr: desc };
  }

  const { data: sticker, error } = await db
    .from('stickers')
    .upsert({ id, name, url: dataUrl, descr: desc })
    .select()
    .single();

  if (error) {
    if (error.code === '42P01') {
      throw new Error('stickers 表不存在，请先在 Supabase 中创建表');
    }
    throw error;
  }

  return sticker;
}

/**
 * 删除表情包
 */
async function deleteSticker(id) {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from('stickers').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 生成注入 prompt 的表情列表块（只注入名字+描述，不注入 URL）
 */
async function stickerPromptBlock(stickers) {
  if (!stickers.length) return '';
  const list = stickers.map(s => `· ${s.name}：${s.descr}`).join('\n');

  try {
    const resolved = await skills.resolve('tool-sticker-prompt', { stickerList: list });
    if (resolved && resolved.trim()) return resolved;
  } catch (_) { /* fall through to legacy */ }

  return (
    '\n\n（你有这些表情包，想发就在回复里写 [sticker:名字]，' +
    '名字要和下面完全一致；情绪到位再发、别硬塞、一条消息最多一个）：\n' +
    list
  );
}

/**
 * 替换回复中的 [sticker:名字] 标记为前端能识别的图片标记
 */
const STICKER_MARK = /\[sticker[:：]\s*([^\]\n]+?)\s*\]/g;

function replaceStickerTags(text, stickers) {
  const map = {};
  for (const s of stickers) {
    map[s.name] = s.url;
  }

  return text.replace(STICKER_MARK, (match, name) => {
    const s = map[name.trim()];
    return s ? `[STICKER_IMG]${s.url}[/STICKER_IMG]` : match;
  });
}

module.exports = {
  getStickers,
  searchStickers,
  searchExternalStickers,
  addExternalSticker,
  uploadSticker,
  deleteSticker,
  stickerPromptBlock,
  replaceStickerTags,
};
