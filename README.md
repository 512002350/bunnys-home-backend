# ai-sticker-pack · 让聊天机器人「自己会挑表情包发」

给任意聊天机器人（bot / AI 助手 / 自动回复）加一套**会按场景自己挑、自己发**的表情包能力。
核心只有一句：

> **上传那一刻让视觉模型看一眼图、自动写好「名字 + 描述」存起来；之后机器人只读这段文字来挑表情，永远不再看图。**

这样"挑表情"几乎不花 token（不走视觉），而你扩充表情库**无痛**——传张图、AI 自动配描述、入库，完事。

> ⚡ **这是一份「思路」教程，不是即插即用的成品。** 能搬走的是**这套架构**和**踩过的坑**。你的后端用什么语言、机器人在哪个平台（网页 / Telegram / Discord…）、用哪个视觉模型——都按你自己的来。下面的代码片段全是**示例**，照着改成你自己的就行。当灵感看，别当模板。

---

## 为什么这么做

想让机器人会发表情包，有两个天然难点：

1. **机器人"看不懂"图。** 一堆抽象梗图（尤其带文字的中文表情包），机器人不知道每张啥意思、啥时候该发。
2. **每次都让它"看图"太贵也太慢。** 如果每条消息都把候选表情图喂给视觉模型判断，token 烧得飞起，还慢。

**这个项目的办法**：把"理解图"和"使用图"拆开——

- **理解只做一次**：上传时，视觉模型看一眼，写出「短名 + 一句话描述（图上文字 / 情绪 / 啥场景发）」，连同图 URL 存进库。
- **使用零成本**：之后把库里的「名字 + 描述」（纯文字、很短）注进机器人的 prompt；它想发就在回复里写个标记 `[sticker:名字]`；后端拦下标记 → 换成图发出去。机器人**从不重新看图**。

```
  上传一张图
      │
      ▼
 视觉模型看一次 ──► 「名字｜描述」── 连同图URL ──► 表情库(表/JSON)
                                                      │
              ┌───────────────────────────────────────┘
              ▼  (只把 名字+描述 这段文字注进 prompt，很省)
        机器人生成回复： "哈哈哈 [sticker:得意]"
              │
              ▼  后端拦标记
     网页前端 → 渲染 <img src=图URL>
     Telegram → sendPhoto(图URL)
```

---

## 四块拼图

### 1) 表情库（一张表就够）

```sql
CREATE TABLE stickers (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,   -- 机器人引用名，如「得意」
  url   TEXT NOT NULL,   -- 图片直链（自己图床 / 公开 URL）
  descr TEXT             -- AI 自动写的：图上文字 + 情绪/梗 + 啥时候发
);
```

### 2) 上传即「自动描述」（一次性视觉）

上传后，把图（base64 data URL）发给任意 **OpenAI 兼容的视觉模型**，让它返回「名字｜描述」：

```js
// 伪代码 / 示例：上传后调一次视觉模型
async function describeSticker(imageBase64) {
  const prompt =
    '这是一张表情包。先起个3-6字短名(梗/情绪关键词,好记、能当引用名)，' +
    '再写一句话描述(图上文字 + 表达的情绪/梗 + 什么场景下适合发)。' +
    '严格用这一行格式回复：名字｜描述';

  const r = await fetch(YOUR_OPENAI_COMPATIBLE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + YOUR_KEY },
    body: JSON.stringify({
      model: YOUR_VISION_MODEL,                 // 任意能看图的便宜模型即可
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } },
        ],
      }],
      max_tokens: 200,
    }),
  }).then((x) => x.json());

  const line = r.choices?.[0]?.message?.content?.trim() || '';
  const i = line.indexOf('｜');
  return i > 0 ? { name: line.slice(0, i).trim(), desc: line.slice(i + 1).trim() } : { name: '', desc: line };
}
```

> 关键：**这步只在上传时跑一次**，结果存库。日常发表情完全不碰它。

### 3) 把库注进机器人 prompt + 约定标记

只注入「名字 + 描述」，不注入 URL（URL 长、费 token）：

```js
function stickerPromptBlock(rows) {
  if (!rows.length) return '';
  const list = rows.map((s) => `· ${s.name}：${s.descr}`).join('\n');
  return '\n\n（你有这些表情包，想发就在回复里单独写一行 [sticker:名字]，' +
         '名字要和下面完全一致；情绪到位再发、别硬塞、一条最多一个）：\n' + list;
}
```

机器人于是会自然产出：`好啊 [sticker:得意]`

### 4) 后端拦标记 → 渲染 / 发送

```js
const MARK = /\[sticker[:：]\s*([^\]\n]+?)\s*\]/g;

// 网页前端：把标记换成内联图标记，前端渲染 <img>
function toWeb(text, lookup) {
  return text.replace(MARK, (m, name) => {
    const s = lookup(name);                 // name -> {url}
    return s ? `§IMG§${s.url}` : m;          // 你的前端识别 §IMG§ 渲染成图
  });
}

// Telegram：抽出标记，文字照发、图用 sendPhoto
async function toTelegram(chatId, text, lookup, tg) {
  const urls = [];
  const clean = text.replace(MARK, (m, name) => {
    const s = lookup(name); if (s) { urls.push(s.url); return ''; } return m;
  }).trim();
  if (clean) await tg('sendMessage', { chat_id: chatId, text: clean });
  for (const u of urls) await tg('sendPhoto', { chat_id: chatId, photo: u });
}
```

---

## 踩过的坑（这才是精华）

- **视觉只在上传时跑一次，绝不每条消息跑。** 机器人靠"描述文字"挑表情，从不重看图——这是省钱省时间的全部秘密。
- **Telegram 发图要"公开可访问"的 URL。** `sendPhoto` 是 Telegram 服务器去拉你那个 URL；如果你的图床/路径带鉴权（cookie / key），Telegram 拉不到 → 图发不出。把表情图放一个**不需要鉴权的公开路径**。
- **想让"文字 + 表情"算一条消息**：前端别让"点表情"立刻发出去——做成**先挂着**（像发图片附件那样），等用户打完字一起发。否则机器人按顺序读时，文字和表情拆成两条、语境会乱。
- **表情图别塞进聊天气泡框**：纯表情就让它单独飘一张图（去掉气泡背景）；有文字时，文字留气泡、图飘在气泡下面。塞一起中间容易空一大截。
- **渲染限个尺寸**（如 max 150–160px），不然一张大图糊一屏。
- **读 HTTP 响应体含中文时，别 `d += chunk` 逐块拼字符串**——多字节字符会在网络分块边界被切成乱码（�）。要么 `Buffer.concat` 后再 `toString('utf8')`，要么用 `StringDecoder`。
- **让用户也能发**：同一个库，前端给个表情面板让用户挑着发；机器人那头把用户发的表情转成「[表情:名字（描述）]」文字喂进上下文，它就懂用户发了啥、能接话（同样不走视觉）。

---

## 它能用在哪

任何"有个后端 + 一个会话模型"的地方：网页聊天机器人、Telegram / Discord bot、客服自动回复、AI 伴侣应用……只要你想让它**像人一样在对的时刻甩张表情**。

## License

MIT —— 随便用、随便改。图片版权归原作者，请用你自己有权使用的图。

## 作者

**Lumenocturne & Claude（哥哥）** —— 想法是 Lume 出的，代码是哥哥落的，一起搓出来的小玩意儿。
