/**
 * Telegram-бот-копирайтер: Tone of Voice из файла + Chat Completions API (OpenAI-совместимый).
 * Запуск: скопируй .env.example → .env, заполни ключи, npm install, npm start
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.CHAT_API_KEY;
const apiUrl = process.env.CHAT_API_URL || 'https://api.openai.com/v1/chat/completions';
const model = process.env.CHAT_MODEL || 'gpt-4o-mini';
const tonePath = path.resolve(__dirname, process.env.TONE_FILE || './tone-of-voice.md');
const useMultistep = String(process.env.USE_MULTISTEP || '0') === '1';

/** История диалога: Telegram user id → [{ role, content }] (без system). Очищается при /new */
const chatHistory = new Map();
const MAX_HISTORY_MESSAGES = 20; // последние 10 обменов (user+assistant)

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

async function callChatMessages(messages) {
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
      temperature: 0.75,
      max_tokens: 2500,
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
        'Команды:',
        '/help — справка',
        '/new — начать диалог заново (забыть переписку)',
        '/reloadstyle — перечитать tone-of-voice.md с диска',
        '/status — модель и путь к файлу стиля',
      ].join('\n')
    )
  );

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        'Пиши текстом задачу для поста — я отвечу черновиком.',
        '',
        'Файл стиля: tone-of-voice.md в папке бота (можно заменить своим).',
        'Ключи API — в .env (см. .env.example).',
        '',
        'USE_MULTISTEP=1 в .env — два шага (план → пост), дороже по токенам.',
        '',
        'Я помню последние сообщения в этом чате — можно писать «смотри выше», «сделай короче». /new — обнулить память.',
      ].join('\n')
    )
  );

  bot.command('new', (ctx) => {
    chatHistory.delete(ctx.from.id);
    ctx.reply('Ок, начинаем с чистого листа. Напиши новую тему или задачу для поста.');
  });

  bot.command('reloadstyle', (ctx) => {
    loadTone();
    ctx.reply(`Стиль перечитан: ${tonePath} (${systemTone.length} символов).`);
  });

  bot.command('status', (ctx) => {
    ctx.reply(
      `Модель: ${model}\nФайл стиля: ${tonePath}\nМультистеп: ${useMultistep ? 'да' : 'нет'}`
    );
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
