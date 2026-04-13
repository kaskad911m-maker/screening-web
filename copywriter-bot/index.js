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

/** История диалога: Telegram user id → [{ role, content }] (без system). Очищается при /new */
const chatHistory = new Map();
const MAX_HISTORY_MESSAGES = 20; // последние 10 обменов (user+assistant)

/** Последние 3 темы из «Тренды» для инлайн-кнопок «Пост по теме N» */
const lastTrendsByUser = new Map();

let systemTone = '';

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
- Без выдуманных фактов и цифр о клиентах — если нужен пример, помечай как гипотетический.`;
}

function trimHistory(arr) {
  while (arr.length > MAX_HISTORY_MESSAGES) arr.shift();
}

async function callChatMessages(messages, opts = {}) {
  if (!apiKey) throw new Error('Нет CHAT_API_KEY в .env');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (apiUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE || 'https://localhost';
    headers['X-Title'] = 'Copywriter Bot';
  }

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers,
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

/** Опционально: Tavily — короткие выдержки из поиска (ключ в .env). */
async function fetchTrendWebContext() {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return '';
  try {
    const year = new Date().getFullYear();
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: `${nicheHint} тренды контент маркетинг Telegram малый бизнес ${year}`,
        search_depth: 'basic',
        max_results: 5,
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const lines = (data.results || [])
      .map((r) => {
        const t = r.title || '';
        const c = String(r.content || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 320);
        return `- ${t}: ${c}`;
      })
      .join('\n');
    return lines.slice(0, 4000);
  } catch {
    return '';
  }
}

function trendsReplyKeyboard() {
  return Markup.keyboard([['📈 Тренды']]).resize();
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
  const sys = `Ты аналитик тем для контента в нише автора.
Ниша (кратко): ${nicheHint}.
${
  webCtx
    ? 'Ниже — выдержки из поиска в интернете: опирайся на смыслы, не копируй длинные куски дословно.'
    : `Веб-поиска нет — предложи 3 сильные, правдоподобные для ${year} года темы под эту нишу (типичные боли и вопросы аудитории). Без вымышленных «срочных новостей» и конкретных дат СМИ.`
}

Ответь СТРОГО одним JSON-массивом из ровно 3 объектов, без Markdown и без текста до/после:
[{"title":"...","angle":"..."}]
Поля: title — короткое название темы поста; angle — крючок для первого абзаца (1–2 предложения). Язык: русский.`;

  const userBlock = [
    `Фрагмент Tone of Voice автора:\n${systemTone.slice(0, 2800)}`,
    webCtx ? `\n--- Поиск ---\n${webCtx}\n--- конец ---\n` : '',
    '\nВерни только JSON-массив из 3 элементов.',
  ].join('');

  const raw = await callChatMessages(
    [
      { role: 'system', content: sys },
      { role: 'user', content: userBlock },
    ],
    { temperature: 0.42, max_tokens: 900 }
  );

  const topics = parseTrendsJson(raw);
  lastTrendsByUser.set(userId, topics);
  const textLines = topics.map((t, i) => `${i + 1}. ${t.title}\n   ${t.angle}`);
  const header = webCtx
    ? '🔎 Три темы под твою нишу (поиск в сети + твой Tone of Voice):'
    : '✨ Три рабочих темы под твою нишу (без внешнего поиска). Для выдачки из интернета добавь в .env ключ TAVILY_API_KEY (tavily.com):';
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
        'Кнопка «📈 Тренды» внизу или /trends — три актуальные темы под твою нишу; затем «Пост по теме».',
        '',
        'Команды:',
        '/help — справка',
        '/trends — то же, что кнопка «Тренды»',
        '/new — начать диалог заново (забыть переписку)',
        '/reloadstyle — перечитать tone-of-voice.md с диска',
        '/status — модель и путь к файлу стиля',
      ].join('\n'),
      trendsReplyKeyboard()
    )
  );

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        'Пиши текстом задачу для поста — я отвечу черновиком.',
        '',
        '«📈 Тренды» или /trends — подбор 3 тем под нишу (опционально с поиском в сети, см. TAVILY_API_KEY в .env.example).',
        'После списка тем нажми инлайн-кнопку «Пост по теме N» — сгенерирую пост.',
        '',
        'Файл стиля: tone-of-voice.md в папке бота (можно заменить своим).',
        'Ключи API — в .env (см. .env.example).',
        '',
        'USE_MULTISTEP=1 в .env — два шага (план → пост), дороже по токенам.',
        '',
        'Я помню последние сообщения в этом чате — можно писать «смотри выше», «сделай короче». /new — обнулить память.',
      ].join('\n'),
      trendsReplyKeyboard()
    )
  );

  bot.command('trends', (ctx) => sendTrendsReply(ctx));

  bot.command('new', (ctx) => {
    chatHistory.delete(ctx.from.id);
    lastTrendsByUser.delete(ctx.from.id);
    ctx.reply('Ок, начинаем с чистого листа. Напиши новую тему или задачу для поста.', trendsReplyKeyboard());
  });

  bot.command('reloadstyle', (ctx) => {
    loadTone();
    ctx.reply(`Стиль перечитан: ${tonePath} (${systemTone.length} символов).`, trendsReplyKeyboard());
  });

  bot.command('status', (ctx) => {
    ctx.reply(
      `Модель: ${model}\nФайл стиля: ${tonePath}\nМультистеп: ${useMultistep ? 'да' : 'нет'}\nTavily (поиск трендов): ${
        process.env.TAVILY_API_KEY ? 'да' : 'нет'
      }\nNICHE_HINT: ${nicheHint.slice(0, 120)}${nicheHint.length > 120 ? '…' : ''}`
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
      const chunks = splitTelegram(out, 3900);
      for (let c = 0; c < chunks.length; c++) {
        await ctx.reply(chunks[c]);
      }
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
      const chunks = splitTelegram(out, 3900);
      for (let c = 0; c < chunks.length; c++) {
        await ctx.reply(chunks[c]);
      }
    } catch (e) {
      await ctx.reply(`Ошибка: ${e.message}\n\nПроверь CHAT_API_KEY и лимиты API.`);
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
