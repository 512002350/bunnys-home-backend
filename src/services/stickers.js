/**
 * 表情包服务
 *
 * 上传时视觉模型看一眼写好描述 → 之后只读文字描述来挑表情 → 不再看图
 * 图片保存到本地 public/uploads/stickers/ 目录，通过 /uploads/stickers/xxx 访问
 */

const path = require('path');
const fs = require('fs');
const { getSupabase } = require('./supabase');
const { describeImage } = require('./imageVision');

/**
 * 获取所有表情包
 */
async function getStickers() {
  const db = getSupabase();
  if (!db) return []; // 无数据库时返回空
  const { data, error } = await db
    .from('stickers')
    .select('*')
    .order('name', { ascending: true });
  if (error) {
    if (error.code === '42P01') return []; // 表还没创建
    throw error;
  }
  return data || [];
}

/**
 * 上传表情包 —— 调视觉模型自动描述 → 存文件 → 入库
 * @param {string} imageBase64 - 图片的 base64 编码（不含 data:image/xxx;base64, 前缀）
 * @param {string} mimeType - 图片 MIME 类型，默认 'image/png'
 */
async function uploadSticker(imageBase64, mimeType = 'image/png') {
  const stickerPrompt =
    '这是一张表情包。先起个3-6字短名(梗/情绪关键词,好记、能当引用名)，' +
    '再写一句话描述(图上文字 + 表达的情绪/梗 + 什么场景下适合发)。' +
    '严格用这一行格式回复：名字｜描述';

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

  // 2. 生成 id 和文件名
  const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '');
  const ext = mimeType.split('/')[1] || 'png';
  const filename = `${id}.${ext}`;

  // 3. 保存图片到本地 public/uploads/stickers/
  const stickersDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'stickers');
  if (!fs.existsSync(stickersDir)) {
    fs.mkdirSync(stickersDir, { recursive: true });
  }
  const filePath = path.join(stickersDir, filename);
  const buffer = Buffer.from(imageBase64, 'base64');
  fs.writeFileSync(filePath, buffer);

  // 4. 存储 URL 路径（可公开访问的相对路径）
  const url = `/uploads/stickers/${filename}`;

  const db = getSupabase();
  if (!db) {
    // 无数据库模式：返回构造的 sticker 对象但不存储
    return { id, name, url, descr: desc };
  }

  const { data: sticker, error } = await db
    .from('stickers')
    .upsert({ id, name, url, descr: desc })
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
function stickerPromptBlock(stickers) {
  if (!stickers.length) return '';
  const list = stickers.map(s => `· ${s.name}：${s.descr}`).join('\n');
  return (
    '\n\n（你有这些表情包，想发就在回复里写 [sticker:名字]，' +
    '名字要和下面完全一致；情绪到位再发、别硬塞、一条消息最多一个）：\n' +
    list
  );
}

/**
 * 替换回复中的 [sticker:名字] 标记为前端能识别的图片标记
 * 前端渲染时把 [STICKER_IMG]...[/STICKER_IMG] 替换成 <img> 标签
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
  uploadSticker,
  deleteSticker,
  stickerPromptBlock,
  replaceStickerTags,
};
