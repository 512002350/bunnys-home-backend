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
 * 搜狗表情包外部搜索（通过 API盒子 搜狗版免费接口）
 * 文档: https://api.aa1.cn/doc/apihzbqbsougou.html
 *
 * 默认使用公共测试号（id=88888888, key=88888888），免费无需注册。
 * 如公共号被限流，可去 cn.apihz.com 注册获取自己的 ID+KEY 填入 .env。
 */
const APIHEZI_ID = process.env.APIHEZI_ID || '88888888';
const APIHEZI_KEY = process.env.APIHEZI_KEY || '88888888';
const SOGOU_API = 'https://cn.apihz.cn/api/img/apihzbqbsougou.php';

async function searchExternalStickers(query) {
  if (!query || !query.trim()) return [];

  try {
    const url = `${SOGOU_API}?id=${APIHEZI_ID}&key=${APIHEZI_KEY}&words=${encodeURIComponent(query.trim())}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();

    if (json.code !== 200 || !json.res?.length) {
      if (json.msg) console.warn('[Stickers] 搜狗API:', json.msg);
      return [];
    }

    // 搜狗返回较多，取前 20 条
    return json.res.slice(0, 20).map((imgUrl, i) => ({
      id: `ext-sogou-${Date.now()}-${i}`,
      name: `${query}${i + 1}`,
      url: imgUrl,
      descr: `搜狗表情: ${query}`,
      external: true,
    }));
  } catch (err) {
    console.warn('[Stickers] 搜狗搜索失败:', err.message);
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
  const list = stickers.length > 0
    ? stickers.map(s => `· ${s.name}：${s.descr}`).join('\n')
    : '';

  // 尝试从 skill registry 获取完整说明（含联网搜索指令）
  try {
    const resolved = await skills.resolve('tool-sticker-prompt', { stickerList: list });
    if (resolved && resolved.trim()) return resolved;
  } catch (_) { /* fall through to legacy */ }

  // Legacy fallback
  const usageGuide =
    '\n\n' +
    '【表情包使用规则】\n' +
    '- 你有本地表情包库（见下方列表）。发送本地表情用 [sticker:名字]，名字必须和列表中完全一致。\n' +
    '- 你还可以从互联网搜索表情包：用 [sticker-search:关键词]（例如 [sticker-search:猫猫哭泣]），' +
    '系统会自动帮你找到最匹配的表情发出去。\n' +
    '- 情绪到位才发，别硬塞。一次最多发一条表情。\n';

  if (stickers.length > 0) {
    return usageGuide + '（本地表情库）：\n' + list;
  }
  return usageGuide + '（本地表情库暂时为空，想发图就用 [sticker-search:关键词] 去搜吧）';
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

/**
 * 替换回复中的 [sticker-search:关键词] 标记
 * AI 用这个语法来搜索互联网表情包 → 搜狗 API → 返回第一张
 */
const STICKER_SEARCH_MARK = /\[sticker-search[:：]\s*([^\]\n]+?)\s*\]/g;

async function replaceStickerSearchTags(text) {
  // 找到所有 sticker-search 标记
  const matches = [...text.matchAll(STICKER_SEARCH_MARK)];
  if (!matches.length) return text;

  let result = text;

  for (const match of matches) {
    const keyword = match[1].trim();
    try {
      const stickers = await searchExternalStickers(keyword);
      if (stickers.length > 0) {
        // 用第一张替换
        result = result.replace(match[0], `[STICKER_IMG]${stickers[0].url}[/STICKER_IMG]`);
      } else {
        // 没找到就删掉标记，不留残骸
        result = result.replace(match[0], '');
      }
    } catch (_) {
      result = result.replace(match[0], '');
    }
  }

  return result;
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
  replaceStickerSearchTags,
};
