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

Как отвечать:
- Выдавай готовый текст поста для публикации (без вступлений «конечно, вот пост»).
- 150–400 слов, если пользователь не указал другую длину.
- 2–4 эмодзи только если усиливают смысл.
- Один чёткий призыв к действию в конце.
- Без выдуманных фактов и цифр о клиентах — если нужен пример, помечай как гипотетический.`;
}

async function callChat(system, userMessage) {
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
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
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

async function generatePost(userRequest) {
  if (useMultistep) {
    const analystSystem = `Ты аналитик стиля и контента. Кратко, 5–8 строк на русском: для поста на тему пользователя — аудитория, боль, крючок, одна мысль поста. Без воды.`;
    const plan = await callChat(analystSystem, `Тема / задача:\n${userRequest}`);
    const writerSystem = baseSystemPrompt();
    const post = await callChat(
      writerSystem,
      `Краткий план (учти при написании):\n${plan}\n\nНапиши финальный пост по исходной задаче:\n${userRequest}`
    );
    return `📋 Черновик плана\n${plan}\n\n✍️ Пост\n${post}`;
  }
  return await callChat(baseSystemPrompt(), userRequest);
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
      ].join('\n')
    )
  );

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
      const out = await generatePost(text);
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
