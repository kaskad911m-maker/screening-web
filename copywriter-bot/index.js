/**
 * Telegram-бот-копирайтер: Tone of Voice из файла + Chat Completions API (OpenAI-совместимый).
 * Запуск: скопируй .env.example → .env, заполни ключи, npm install, npm start
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.CHAT_API_KEY;
const apiUrl = process.env.CHAT_API_URL || 'https://api.openai.com/v1/chat/completions';
const model = process.env.CHAT_MODEL || 'gpt-4o-mini';
const tonePath = path.resolve(__dirname, process.env.TONE_FILE || './tone-of-voice.md');
const useMultistep = String(process.env.USE_MULTISTEP || '0') === '1';
const nicheHint = (process.env.NICHE_HINT || '').trim() || 'вайбкодинг, цифровые продукты и лендинги без «магии IT» для экспертов и малого бизнеса';
/** Доп. угол для трендов (запросы Tavily + текст урока «куда смотреть») */
const trendFocusExtra = (process.env.TREND_FOCUS || '').trim();
/** Отправка поста с **…** → Telegram HTML <b>…</b> (0 = только plain) */
const postBoldHtml = String(process.env.POST_BOLD_HTML || '1') === '1';

function nicheLineForTrends() {
  return trendFocusExtra ? `${nicheHint} Доп. фокус: ${trendFocusExtra}` : nicheHint;
}

/** История диалога: Telegram user id → [{ role, content }] (без system). Очищается при /new */
const chatHistory = new Map();
const MAX_HISTORY_MESSAGES = 20; // последние 10 обменов (user+assistant)

/** Последние 3 темы из «Тренды» для инлайн-кнопок «Пост по теме N» */
const lastTrendsByUser = new Map();

/** Последний сгенерированный пост (тело), к которому привязана «Картинка к посту» */
const lastPostForImageByUser = new Map();

let systemTone = '';

/** Выделить текст поста из ответа ассистента (план+пост или только пост). */
function extractPostBodyForImage(stored) {
  const s = String(stored || '').trim();
  const i = s.indexOf('✍️ Пост\n');
  if (i >= 0) return s.slice(i + '✍️ Пост\n'.length).trim();
  const j = s.indexOf('✅ Исправленный пост\n\n');
  if (j >= 0) return s.slice(j + '✅ Исправленный пост\n\n'.length).trim();
  if (s.startsWith('📋') && !s.includes('✍️ Пост')) return '';
  return s;
}

function rememberLastPostForImage(userId, assistantFullText) {
  const body = extractPostBodyForImage(assistantFullText);
  if (body.length >= 35) lastPostForImageByUser.set(userId, body);
}

function loadTone() {
  try {
    systemTone = fs.readFileSync(tonePath, 'utf8');
  } catch {
    systemTone =
      'Пиши по-русски, просто и дружелюбно. Аудитория — малый бизнес и эксперты без IT-фона. Без канцелярита.';
  }
}

function baseSystemPrompt() {
  return `Ты бот-копирайтер для Telegram-канала вайбкодера / эксперта по цифровым продуктам.

Ниже — Tone of Voice автора. Строго соблюдай стиль, лексику и правила.

---

${systemTone}

---

Автор постов — женщина (вайбкодер / эксперт). Пиши от первого лица в женском роде там, где уместно «я»: я сделала, я вижу, мне важно, устала объяснять, готова помочь, мой опыт. Не используй мужские формы про себя («я сделал», «готов» в значении муж. рода о себе). Обращение к читателю — как в Tone of Voice (ты/вы).

Контекст диалога:
- В сообщениях ниже может быть история переписки. Если пользователь пишет «как выше», «смотри выше», «допиши», «короче», «другой тон» — опирайся на предыдущие реплики в этом чате, не начинай «с нуля».
- Если просят изменить уже сгенерированный текст — правь его, сохраняя смысл.

Как отвечать:
- Выдавай готовый текст поста для публикации (без вступлений «конечно, вот пост»), если пользователь не просит явно только правку одного абзаца.
- 150–400 слов, если пользователь не указал другую длину.
- 2–4 эмодзи только если усиливают смысл.
- Один чёткий призыв к действию в конце (если уместен пост, а не короткая правка).
- Без выдуманных фактов и цифр о клиентах — если нужен пример, помечай как гипотетический.
- Для публикации в Telegram: 5–10 самых сильных формулировок (слово, короткая фраза) выделяй **двойными звёздочками** — так: **важная мысль**. Не дроби каждое слово; не больше одного выделения в строке.`;
}

function trimHistory(arr) {
  while (arr.length > MAX_HISTORY_MESSAGES) arr.shift();
}

function buildApiHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (apiUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE || 'https://localhost';
    headers['X-Title'] = 'Copywriter Bot';
  }
  return headers;
}

async function callChatMessages(messages, opts = {}) {
  if (!apiKey) throw new Error('Нет CHAT_API_KEY в .env');

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: buildApiHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.75,
      max_tokens: opts.max_tokens ?? 2500,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${raw.slice(0, 600)}`);
  }
  const data = JSON.parse(raw);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Пустой ответ API');
  return text.trim();
}

const TAVILY_ALLOWED_DEPTH = new Set(['basic', 'advanced', 'fast', 'ultra-fast']);

function normalizeTavilySearchDepth() {
  const d = String(process.env.TAVILY_SEARCH_DEPTH || 'basic')
    .trim()
    .toLowerCase();
  return TAVILY_ALLOWED_DEPTH.has(d) ? d : 'basic';
}

/**
 * Один запрос к Tavily. opts.omitTimeRange — без фильтра даты (часто даёт 0 ссылок на узкую нишу).
 * include_answer — краткая сводка от Tavily, если сниппеты пустые или короткие.
 */
async function tavilySearchOnce(query, opts = {}) {
  const key = String(process.env.TAVILY_API_KEY || '').trim();
  if (!key) return '';
  const topicRaw = (process.env.TAVILY_TOPIC || 'general').trim().toLowerCase();
  const topic = topicRaw === 'news' || topicRaw === 'finance' ? topicRaw : 'general';
  const tr = (process.env.TAVILY_TIME_RANGE || '').trim();
  const depth = normalizeTavilySearchDepth();
  const maxR = Math.min(15, Math.max(3, parseInt(process.env.TAVILY_MAX_RESULTS || '8', 10) || 8));

  const body = {
    query: String(query).trim().slice(0, 400),
    search_depth: depth,
    max_results: maxR,
    topic,
    include_answer: 'basic',
  };
  if (!opts.omitTimeRange && ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'].includes(tr)) {
    body.time_range = tr;
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.warn('[Tavily] не JSON в ответе', res.status, rawText.slice(0, 200));
    return '';
  }

  if (!res.ok) {
    const err = data?.detail?.error || data?.message || rawText.slice(0, 300);
    console.warn('[Tavily] HTTP', res.status, err);
    return '';
  }

  const lines = (data.results || [])
    .map((r) => {
      const t = r.title || '';
      const c = String(r.content || r.raw_content || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 320);
      return t || c ? `- ${t}: ${c}` : '';
    })
    .filter(Boolean);

  const answer = String(data.answer || '').replace(/\s+/g, ' ').trim();
  const parts = [];
  if (lines.length) parts.push(lines.join('\n'));
  if (answer) parts.push(`Сводка по запросу: ${answer.slice(0, 1200)}`);
  return parts.join('\n\n').trim();
}

/** Tavily: веб + опционально второй запрос «соцсети / SMM» (урок: интернет и соцсети). */
async function fetchTrendWebContext() {
  const key = String(process.env.TAVILY_API_KEY || '').trim();
  if (!key) return '';
  try {
    const year = new Date().getFullYear();
    const line = nicheLineForTrends();
    const qMain = `${line} тренды контент маркетинг Telegram малый бизнес ${year}`;
    let block = await tavilySearchOnce(qMain);

    if (!block) {
      block = await tavilySearchOnce(qMain, { omitTimeRange: true });
    }
    if (!block) {
      block = await tavilySearchOnce(
        `${line} content marketing trends expert audience ${year}`,
        { omitTimeRange: true }
      );
    }
    if (!block) {
      block = await tavilySearchOnce(
        `Telegram channel growth content strategy small business ${year}`,
        { omitTimeRange: true }
      );
    }

    if (String(process.env.TAVILY_SOCIAL_EXTRA || '').trim() === '1') {
      const q2 = `${line} SMM Telegram ВКонтакте продвижение эксперта тренды ${year}`;
      let b2 = await tavilySearchOnce(q2);
      if (!b2) b2 = await tavilySearchOnce(q2, { omitTimeRange: true });
      if (!b2) b2 = await tavilySearchOnce(`social media marketing trends engagement ${year}`, { omitTimeRange: true });
      if (b2) block += `${block ? '\n\n' : ''}--- Соцсети и продвижение ---\n${b2}`;
    }
    return block.slice(0, 4500);
  } catch (e) {
    console.warn('[Tavily] fetchTrendWebContext', e.message || e);
    return '';
  }
}

function mainReplyKeyboard() {
  return Markup.keyboard([
    ['📈 Тренды'],
    ['🎯 Идеи заголовков', '🗣 Боли аудитории'],
    ['✂️ Критика поста', '🖼 Картинка к посту'],
  ]).resize();
}

function parseTrendsJson(raw) {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  const arr = JSON.parse(s);
  if (!Array.isArray(arr) || arr.length < 1) throw new Error('ожидался JSON-массив');
  const slice = arr.slice(0, 3);
  while (slice.length < 3) {
    slice.push({ title: `Тема ${slice.length + 1}`, angle: 'Уточни нишу в NICHE_HINT в .env' });
  }
  return slice.map((item, i) => ({
    title: String(item.title || item.t || `Тема ${i + 1}`).slice(0, 200),
    angle: String(item.angle || item.hook || item.description || '').slice(0, 450),
  }));
}

async function runTrendsForUser(userId) {
  const webCtx = await fetchTrendWebContext();
  const year = new Date().getFullYear();
  const tavilyKey = !!(process.env.TAVILY_API_KEY && String(process.env.TAVILY_API_KEY).trim());
  const sys = `Ты аналитик тем для контента в нише автора.
Ниша (кратко): ${nicheLineForTrends()}.
${
  webCtx
    ? 'Ниже — выдержки из поиска в интернете (Tavily): опирайся на смыслы, не копируй длинные куски дословно.'
    : tavilyKey
      ? `Веб-поиск настроен, но выдача пустая или с ошибкой — предложи 3 сильные темы на ${year} год из своих знаний + Tone of Voice.`
      : `Интернет-поиск выключен (нет ключа Tavily) — предложи 3 сильные, разные темы на ${year} год под нишу (боли аудитории). Без вымышленных «срочных новостей».`
}

Ответь СТРОГО одним JSON-массивом из ровно 3 объектов, без Markdown и без текста до/после:
[{"title":"...","angle":"..."}]
Поля: title — короткое название темы поста; angle — крючок для первого абзаца (1–2 предложения). Язык: русский. Три темы должны отличаться по углу (не три однотипных заголовка).`;

  const userBlock = [
    `Фрагмент Tone of Voice автора:\n${systemTone.slice(0, 2800)}`,
    webCtx ? `\n--- Поиск ---\n${webCtx}\n--- конец ---\n` : '',
    `\nУникальность запроса (не повторяй шаблон прошлых ответов): user=${userId} seed=${Date.now()}.`,
    '\nВерни только JSON-массив из 3 элементов.',
  ].join('');

  const raw = await callChatMessages(
    [
      { role: 'system', content: sys },
      { role: 'user', content: userBlock },
    ],
    { temperature: 0.52, max_tokens: 900 }
  );

  const topics = parseTrendsJson(raw);
  lastTrendsByUser.set(userId, topics);
  const textLines = topics.map((t, i) => `${i + 1}. ${t.title}\n   ${t.angle}`);
  let header;
  if (webCtx) {
    header = '🔎 Три темы (интернет: Tavily — выдержки учтены вместе с Tone of Voice):';
  } else if (tavilyKey) {
    header = '⚠️ Три темы (ключ Tavily есть, но поиск не дал текста — темы только от модели):';
  } else {
    header =
      '✨ Три темы (интернет: выключен — добавь TAVILY_API_KEY в .env на Railway для живого поиска). Ниша задаётся в NICHE_HINT и TREND_FOCUS:';
  }
  return `${header}\n\n${textLines.join('\n\n')}`;
}

async function sendTrendsReply(ctx) {
  await ctx.sendChatAction('typing');
  try {
    const text = await runTrendsForUser(ctx.from.id);
    const topics = lastTrendsByUser.get(ctx.from.id) || [];
    await ctx.reply(
      text,
      Markup.inlineKeyboard(topics.map((_, i) => [Markup.button.callback(`✍️ Пост по теме ${i + 1}`, `tr:${i}`)]))
    );
  } catch (e) {
    await ctx.reply(
      `Не получилось собрать тренды: ${e.message}\n\nПопробуй /trends ещё раз или смени модель в CHAT_MODEL.`
    );
  }
}

function getHist(userId) {
  return chatHistory.get(userId) || [];
}

function lastUserSnippet(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === 'user') return String(hist[i].content || '').trim();
  }
  return nicheHint;
}

function lastAssistantText(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === 'assistant') return String(hist[i].content || '');
  }
  return '';
}

function rememberSkill(userId, label, assistantText) {
  const hist = getHist(userId);
  hist.push({ role: 'user', content: label });
  hist.push({ role: 'assistant', content: assistantText });
  trimHistory(hist);
  chatHistory.set(userId, hist);
}

async function skillHooksRun(userId) {
  const hist = getHist(userId);
  const topic = lastUserSnippet(hist);
  const out = await callChatMessages(
    [
      {
        role: 'system',
        content: `Ты редактор заголовков для Telegram. Ниша: ${nicheHint}.
Верни ровно 5 вариантов заголовка (нумерация 1–5, каждый с новой строки). Коротко, по делу, без ложного кликбейта.
Русский язык. Учитывай Tone of Voice из сообщения пользователя.`,
      },
      {
        role: 'user',
        content: `Tone of Voice (фрагмент):\n${systemTone.slice(0, 2200)}\n\nОпора для темы:\n${topic.slice(0, 700)}`,
      },
    ],
    { temperature: 0.65, max_tokens: 500 }
  );
  rememberSkill(userId, '🎯 Идеи заголовков', out);
  return out;
}

async function skillAudienceRun(userId) {
  const out = await callChatMessages(
    [
      {
        role: 'system',
        content:
          'Ты аналитик аудитории. По Tone of Voice выпиши: 5–7 болей или страхов, 3–4 вопроса «в голове» у читателя, 2 формата постов, которые зайдут. Списками. Русский язык.',
      },
      { role: 'user', content: systemTone.slice(0, 3800) },
    ],
    { temperature: 0.5, max_tokens: 900 }
  );
  rememberSkill(userId, '🗣 Боли аудитории', out);
  return out;
}

/** Критика + отдельным сообщением исправленный пост (два запроса к API). */
async function runCritiqueWithRevision(ctx) {
  const userId = ctx.from.id;
  const hist = getHist(userId);
  const last = lastAssistantText(hist);
  if (!last.trim()) {
    await ctx.reply(
      'Пока нет моего текста для разбора. Сначала попроси пост обычным сообщением или через «Тренды».',
      mainReplyKeyboard()
    );
    return;
  }

  await ctx.sendChatAction('typing');
  const critique = await callChatMessages(
    [
      {
        role: 'system',
        content:
          'Ты строгий, но добрый редактор. Разбери черновик поста: сильные стороны, слабый крючок, что сократить, как усилить CTA. До 12 коротких пунктов. Русский язык. Только разбор — без полного переписанного поста здесь.',
      },
      { role: 'user', content: last.slice(0, 4500) },
    ],
    { temperature: 0.45, max_tokens: 900 }
  );

  const critiqueBlock = `✂️ Критика\n\n${critique}`;
  const critiqueChunks = splitTelegram(critiqueBlock, 3900);
  for (let c = 0; c < critiqueChunks.length; c++) {
    await ctx.reply(critiqueChunks[c]);
  }

  await ctx.sendChatAction('typing');
  const revised = await callChatMessages(
    [
      {
        role: 'system',
        content: `${baseSystemPrompt()}\n\nЗадача: переписать существующий пост целиком с учётом критики редактора. Выдай только финальный текст поста для Telegram (примерно 150–450 слов), без преамбулы и без повторения текста критики. Сохрани выделения **как в Tone of Voice** для ключевых фраз.`,
      },
      {
        role: 'user',
        content: `Исходный пост:\n---\n${last.slice(0, 3800)}\n---\n\nКритика:\n---\n${critique.slice(0, 2200)}\n---\n\nНапиши исправленный вариант поста.`,
      },
    ],
    { temperature: 0.65, max_tokens: 2200 }
  );

  const revisedBlock = `✅ Исправленный пост\n\n${revised}`;
  await replyPostChunks(ctx, revisedBlock, mainReplyKeyboard());

  rememberSkill(userId, '✂️ Критика поста', `${critiqueBlock}\n\n---\n\n${revisedBlock}`);
  rememberLastPostForImage(userId, revisedBlock);
}

function extractBase64ImageFromChatResponse(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return null;
  if (Array.isArray(msg.images)) {
    for (const im of msg.images) {
      const u = im?.image_url?.url || im?.url;
      if (u && String(u).startsWith('data:image')) return u;
    }
  }
  const parts = msg.content;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const u = p?.image_url?.url;
      if (u && String(u).startsWith('data:image')) return u;
    }
  }
  const s = JSON.stringify(data);
  const m = s.match(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/i);
  return m ? m[0] : null;
}

function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
  if (!m) return null;
  try {
    return Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
}

async function tryOpenRouterImage(promptEn, aspectNote = '') {
  const imgModel = (process.env.IMAGE_MODEL || '').trim();
  if (!imgModel || !apiKey || !String(apiUrl).includes('openrouter.ai')) return null;
  const aspect = aspectNote ? `${aspectNote} ` : 'Balanced composition. ';
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: buildApiHeaders(),
      body: JSON.stringify({
        model: imgModel,
        messages: [
          {
            role: 'user',
            content: `${aspect}Cover illustration for a Telegram post, soft light, professional, no text or letters in the image. ${promptEn}`,
          },
        ],
        modalities: ['image', 'text'],
        max_tokens: 1024,
      }),
    });
    const raw = await res.text();
    if (!res.ok) return null;
    const data = JSON.parse(raw);
    return extractBase64ImageFromChatResponse(data);
  } catch {
    return null;
  }
}

async function buildImagePromptFromPost(ruExcerpt, layoutHintRu = '') {
  const clean = stripBoldMarkers(String(ruExcerpt)).replace(/\s+/g, ' ').trim().slice(0, 2000);
  const extra = layoutHintRu ? ` Формат кадра: ${layoutHintRu}.` : '';
  const line = await callChatMessages(
    [
      {
        role: 'system',
        content: `Ты арт-директор обложки к посту в Telegram.
Прочитай смысл поста и выдай ОДНУ короткую фразу на АНГЛИЙСКОМ (25–45 слов): конкретная сцена или метафора, которая отражает главную мысль поста (не общие «офис/ноутбук», если пост про другое). Настроение, свет, стиль (иллюстрация / современный flat / soft 3D — что лучше по теме).${extra}
Запрет: буквы, слова, логотипы, UI, скриншоты. Только описание картинки, без кавычек и преамбулы.`,
      },
      { role: 'user', content: clean },
    ],
    { temperature: 0.55, max_tokens: 180 }
  );
  return line.replace(/["'`«»]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
}

function imageFormatKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬛ 1:1 · квадрат (1080)', 'ifm:1080x1080')],
    [Markup.button.callback('▬ 16:9 · шапка поста', 'ifm:1280x720')],
    [Markup.button.callback('▯ 9:16 · сторис', 'ifm:720x1280')],
    [Markup.button.callback('▭ 4:3 · классика', 'ifm:1200x900')],
  ]);
}

/** Показать выбор формата; сама картинка — после нажатия ifm:WxH */
async function promptImageFormatSelection(ctx) {
  const userId = ctx.from.id;
  const excerpt = lastPostForImageByUser.get(userId);
  if (!excerpt || excerpt.length < 30) {
    await ctx.reply(
      'Сначала сгенерируй пост (текстом или через «Тренды» → «Пост по теме»). Обложка цепляется к последнему такому ответу.',
      mainReplyKeyboard()
    );
    return;
  }
  await ctx.reply(
    'Выбери формат обложки под этот пост (дальше соберу промпт и картинку):',
    imageFormatKeyboard()
  );
}

function aspectEnglishForDims(w, h) {
  if (w === h) return 'Square 1:1 composition, centered subject.';
  if (w > h) return `Wide horizontal banner ${w}x${h}, cinematic.`;
  return `Tall vertical ${w}x${h} for mobile stories, strong vertical flow.`;
}

function aspectRussianForPrompt(w, h) {
  if (w === h) return 'квадрат 1:1';
  if (w > h) return 'горизонтально 16:9';
  return 'вертикально 9:16 для сторис';
}

/** Генерация картинки к сохранённому lastPostForImageByUser */
async function sendPostImageWithDimensions(ctx, width, height) {
  const userId = ctx.from.id;
  const excerpt = lastPostForImageByUser.get(userId);
  if (!excerpt || excerpt.length < 30) {
    await ctx.reply('Пост для обложки не найден. Сгенерируй пост ещё раз.', mainReplyKeyboard());
    return;
  }

  const excerptPlain = stripBoldMarkers(excerpt).replace(/\s+/g, ' ').trim();
  const ratioEn = aspectEnglishForDims(width, height);
  const ratioRu = aspectRussianForPrompt(width, height);

  await ctx.sendChatAction('upload_photo');
  let promptEn;
  try {
    promptEn = await buildImagePromptFromPost(excerptPlain, ratioRu);
  } catch {
    promptEn = excerptPlain.slice(0, 200).replace(/\n/g, ' ');
  }

  const dataUrl = await tryOpenRouterImage(promptEn, ratioEn);
  if (dataUrl) {
    const buf = dataUrlToBuffer(dataUrl);
    if (buf && buf.length > 200) {
      await ctx.replyWithPhoto(
        { source: buf },
        {
          caption: `🖼 Обложка ${width}×${height} (OpenRouter). К посту выше.`,
          ...mainReplyKeyboard(),
        }
      );
      return;
    }
  }

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptEn)}?width=${width}&height=${height}&nologo=true&seed=${Date.now() % 99999}`;
  try {
    await ctx.replyWithPhoto(url, {
      caption: `🖼 Черновик ${width}×${height} (Pollinations). К последнему посту.`,
      ...mainReplyKeyboard(),
    });
  } catch (e) {
    await ctx.reply(
      `Картинка не подтянулась (${e.message}). Попробуй другой формат или задай IMAGE_MODEL на OpenRouter.`,
      mainReplyKeyboard()
    );
  }
}

function historyContextBlock(hist) {
  if (!hist.length) return '';
  const lines = hist.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`);
  return `\n\n--- Контекст переписки (связь с «смотри выше» и правками) ---\n${lines.join('\n\n')}\n--- конец контекста ---\n`;
}

/** Короткие отсылки к прошлому сообщению — усиливаем явной подсказкой, чтобы модель не игнорировала историю */
function augmentRequestForFollowUp(userRequest, hist) {
  if (hist.length < 2) return userRequest;
  const t = userRequest.trim();
  const followUp =
    /^(смотри\s+выше|см\.?\s*выше|как\s+выше|выше|продолжи|допиши|добавь|короче|длиннее|ещё|еще|другой\s+тон|переформулируй|исправь|не\s+так|проще|жёстче|мягче|убери|верни|вариант\s*2|по-другому)/i;
  const looksLikeContinuation =
    followUp.test(t) ||
    (t.length < 60 && /выше|прошл|этот\s+текст|тот\s+пост|предыдущ/i.test(t));
  if (!looksLikeContinuation) return userRequest;
  return `${userRequest}\n\n(Важно: это продолжение диалога. Возьми за основу свой последний ответ в истории и доработай/сократи/измени его по этой просьбе. Не начинай новую тему.)`;
}

async function generatePost(userId, userRequest) {
  const hist = chatHistory.get(userId) || [];
  const userRequestEffective = augmentRequestForFollowUp(userRequest, hist);

  if (useMultistep) {
    const analystSystem = `Ты аналитик стиля и контента. Кратко, 5–8 строк на русском: для поста на тему пользователя — аудитория, боль, крючок, одна мысль поста. Без воды. Учитывай предыдущие реплики, если они переданы.`;
    const plan = await callChatMessages([
      { role: 'system', content: analystSystem },
      {
        role: 'user',
        content: `Тема / задача:\n${userRequestEffective}${historyContextBlock(hist)}`,
      },
    ]);
    const writerMessages = [
      { role: 'system', content: baseSystemPrompt() },
      ...hist,
      {
        role: 'user',
        content: `Краткий план (учти при написании):\n${plan}\n\nИсходная задача:\n${userRequestEffective}\n\nНапиши финальный пост.`,
      },
    ];
    const post = await callChatMessages(writerMessages);
    const out = `📋 Черновик плана\n${plan}\n\n✍️ Пост\n${post}`;
    hist.push({ role: 'user', content: userRequest });
    hist.push({ role: 'assistant', content: out });
    trimHistory(hist);
    chatHistory.set(userId, hist);
    rememberLastPostForImage(userId, out);
    return out;
  }

  const messages = [
    { role: 'system', content: baseSystemPrompt() },
    ...hist,
    { role: 'user', content: userRequestEffective },
  ];
  const out = await callChatMessages(messages);
  hist.push({ role: 'user', content: userRequest });
  hist.push({ role: 'assistant', content: out });
  trimHistory(hist);
  chatHistory.set(userId, hist);
  rememberLastPostForImage(userId, out);
  return out;
}

function splitTelegram(text, limit = 4000) {
  if (text.length <= limit) return [text];
  const parts = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + limit));
    i += limit;
  }
  return parts;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Убрать маркеры **…** из текста (для промпта картинки), оставив слова */
function stripBoldMarkers(s) {
  const parts = String(s).split('**');
  return parts.join('');
}

/** Разбить длинный markdown по границам абзацев, чтобы не резать **посередине** */
function chunkMarkdownForTelegram(md, limit = 3800) {
  const text = String(md);
  if (text.length <= limit) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      let sep = slice.lastIndexOf('\n\n');
      let adv = 2;
      if (sep < Math.floor(limit * 0.3)) {
        sep = slice.lastIndexOf('\n');
        adv = 1;
      }
      if (sep < Math.floor(limit * 0.2)) {
        sep = slice.lastIndexOf(' ');
        adv = 1;
      }
      if (sep > 80) end = start + sep + adv;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function boldMarkdownToHtml(s) {
  const parts = String(s).split('**');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) out += escapeHtml(parts[i]);
    else out += `<b>${escapeHtml(parts[i])}</b>`;
  }
  return out;
}

/** Ответ с черновиком поста: при POST_BOLD_HTML — HTML с жирным в Telegram */
async function replyPostChunks(ctx, text, lastExtra = {}) {
  const plainChunks = splitTelegram(text, 3900);
  if (!postBoldHtml) {
    for (let c = 0; c < plainChunks.length; c++) {
      const last = c === plainChunks.length - 1;
      await ctx.reply(plainChunks[c], last ? lastExtra : {});
    }
    return;
  }
  const mdChunks = chunkMarkdownForTelegram(text, 3800);
  for (let c = 0; c < mdChunks.length; c++) {
    const last = c === mdChunks.length - 1;
    const html = boldMarkdownToHtml(mdChunks[c]);
    try {
      await ctx.reply(html, { parse_mode: 'HTML', ...(last ? lastExtra : {}) });
    } catch {
      await ctx.reply(mdChunks[c], last ? lastExtra : {});
    }
  }
}

async function main() {
  if (!token) {
    console.error('Укажи TELEGRAM_BOT_TOKEN в .env (токен от @BotFather)');
    process.exit(1);
  }

  loadTone();
  console.log('Tone of Voice:', tonePath, `(${systemTone.length} символов)`);
  console.log('API:', apiUrl, '| model:', model, '| multistep:', useMultistep);

  const bot = new Telegraf(token);

  bot.start((ctx) =>
    ctx.reply(
      [
        'Привет! Я бот-копирайтер.',
        '',
        'Напиши обычным сообщением, какой нужен пост (тема, тон, длина — по желанию).',
        'Пример: «Пост про то, зачем лендинг, а не сайт на 20 страниц»',
        '',
        'Кнопки внизу: «Тренды», «Идеи», «Боли», «Критика», «Картинка» — см. /help.',
        '',
        'Команды:',
        '/help — справка',
        '/trends — три темы (как кнопка «Тренды»)',
        '/hooks /audience /critique /image — скиллы (то же, что кнопки)',
        '/new — начать диалог заново (забыть переписку)',
        '/reloadstyle — перечитать tone-of-voice.md с диска',
        '/status — модель и путь к файлу стиля',
      ].join('\n'),
      mainReplyKeyboard()
    )
  );

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        'Пиши текстом задачу для поста — я отвечу черновиком.',
        '',
        '«📈 Тренды» или /trends — 3 темы (с интернетом при TAVILY_API_KEY; ниша: NICHE_HINT + TREND_FOCUS).',
        'После тем — инлайн «Пост по теме N». Обычный пост тоже цепляется к «Картинка».',
        '',
        'Скиллы (кнопки или команды):',
        '• 🎯 Идеи заголовков /hooks — 5 заголовков под последнюю тему или нишу.',
        '• 🗣 Боли аудитории /audience — разбор по tone-of-voice.md.',
        '• ✂️ Критика поста /critique — разбор последнего моего текста.',
        '• 🖼 Картинка к посту /image — выбор формата (1:1, 16:9, 9:16, 4:3); к последнему сгенерированному посту.',
        '',
        'Файл стиля: tone-of-voice.md в папке бота (можно заменить своим).',
        'Ключи API — в .env (см. .env.example).',
        '',
        'USE_MULTISTEP=1 в .env — два шага (план → пост), дороже по токенам.',
        'POST_BOLD_HTML=0 — отключить жирный в Telegram (по умолчанию ключевые фразы с ** → <b>).',
        '',
        'Я помню последние сообщения в этом чате — можно писать «смотри выше», «сделай короче». /new — обнулить память.',
      ].join('\n'),
      mainReplyKeyboard()
    )
  );

  bot.command('trends', (ctx) => sendTrendsReply(ctx));

  async function replySkillChunks(ctx, text) {
    const chunks = splitTelegram(text, 3900);
    for (let c = 0; c < chunks.length; c++) {
      const last = c === chunks.length - 1;
      if (last) await ctx.reply(chunks[c], mainReplyKeyboard());
      else await ctx.reply(chunks[c]);
    }
  }

  bot.command('hooks', async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
      const out = await skillHooksRun(ctx.from.id);
      await replySkillChunks(ctx, out);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.command('audience', async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
      const out = await skillAudienceRun(ctx.from.id);
      await replySkillChunks(ctx, out);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.command('critique', async (ctx) => {
    try {
      await runCritiqueWithRevision(ctx);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.command('image', async (ctx) => {
    try {
      await promptImageFormatSelection(ctx);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.hears(/^(🎯\s*)?Идеи заголовков\s*$/i, async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
      const out = await skillHooksRun(ctx.from.id);
      await replySkillChunks(ctx, out);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.hears(/^(🗣\s*)?Боли аудитории\s*$/i, async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
      const out = await skillAudienceRun(ctx.from.id);
      await replySkillChunks(ctx, out);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.hears(/^(✂️\s*)?Критика поста\s*$/i, async (ctx) => {
    try {
      await runCritiqueWithRevision(ctx);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.hears(/^(🖼\s*)?Картинка к посту\s*$/i, async (ctx) => {
    try {
      await promptImageFormatSelection(ctx);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.action(/^ifm:(\d+)x(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const w = parseInt(ctx.match[1], 10);
    const h = parseInt(ctx.match[2], 10);
    if (!w || !h || w > 2048 || h > 2048) return;
    try {
      await sendPostImageWithDimensions(ctx, w, h);
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`, mainReplyKeyboard());
    }
  });

  bot.command('new', (ctx) => {
    chatHistory.delete(ctx.from.id);
    lastTrendsByUser.delete(ctx.from.id);
    lastPostForImageByUser.delete(ctx.from.id);
    ctx.reply('Ок, начинаем с чистого листа. Напиши новую тему или задачу для поста.', mainReplyKeyboard());
  });

  bot.command('reloadstyle', (ctx) => {
    loadTone();
    ctx.reply(`Стиль перечитан: ${tonePath} (${systemTone.length} символов).`, mainReplyKeyboard());
  });

  bot.command('status', (ctx) => {
    const tf = trendFocusExtra ? trendFocusExtra.slice(0, 80) + (trendFocusExtra.length > 80 ? '…' : '') : '(пусто)';
    ctx.reply(
      `Модель: ${model}\nФайл стиля: ${tonePath}\nМультистеп: ${useMultistep ? 'да' : 'нет'}\nTavily: ${
        process.env.TAVILY_API_KEY ? 'да' : 'нет'
      }\nTAVILY_TOPIC: ${(process.env.TAVILY_TOPIC || 'general').trim()}\nTAVILY_SOCIAL_EXTRA: ${String(
        process.env.TAVILY_SOCIAL_EXTRA || '0'
      ).trim()}\nIMAGE_MODEL: ${(process.env.IMAGE_MODEL || '(pollinations)').trim()}\nNICHE_HINT: ${nicheHint.slice(0, 100)}${
        nicheHint.length > 100 ? '…' : ''
      }\nTREND_FOCUS: ${tf}\nPOST_BOLD_HTML: ${postBoldHtml ? 'да' : 'нет'}`,
      mainReplyKeyboard()
    );
  });

  bot.hears(/^📈\s*Тренды\s*$/i, (ctx) => sendTrendsReply(ctx));
  bot.hears(/^Тренды\s*$/i, (ctx) => sendTrendsReply(ctx));

  bot.action(/^tr:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const idx = parseInt(ctx.match[1], 10);
    const topics = lastTrendsByUser.get(ctx.from.id);
    if (!topics || !topics[idx]) {
      await ctx.reply('Сначала нажми «📈 Тренды» или команду /trends.');
      return;
    }
    const t = topics[idx];
    await ctx.sendChatAction('typing');
    try {
      const prompt = [
        'Напиши пост для Telegram-канала.',
        `Тема (заголовочная формулировка): ${t.title}`,
        `Крючок и боль читателя: ${t.angle}`,
        'Сразу готовый текст поста (примерно 150–400 слов), без вступления вроде «конечно, вот пост».',
      ].join('\n');
      const out = await generatePost(ctx.from.id, prompt);
      await replyPostChunks(ctx, out, mainReplyKeyboard());
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  });

  bot.on('text', async (ctx) => {
    const text = (ctx.message.text || '').trim();
    if (!text || text.startsWith('/')) return;

    await ctx.sendChatAction('typing');
    try {
      const out = await generatePost(ctx.from.id, text);
      await replyPostChunks(ctx, out, mainReplyKeyboard());
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}\n\nПроверь CHAT_API_KEY и лимиты API.`, mainReplyKeyboard());
    }
  });

  await bot.launch();
  console.log('Бот запущен. Ctrl+C — остановить.');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
