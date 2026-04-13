---
name: copywriter-bot-m4
description: >-
  Расширение Telegram-бота-копирайтера (copywriter-bot): тренды Tavily, скиллы
  (идеи, аудитория, критика), картинки Pollinations/OpenRouter. Читай при
  правках index.js, .env и деплое Railway.
---

# Бот-копирайтер — расширения урока М4

## Где код

- `copywriter-bot/index.js` — вся логика.
- `copywriter-bot/tone-of-voice.md` — стиль автора.
- `copywriter-bot/.env.example` — список переменных.

## Три блока урока

### 1) Тренды через интернет

- Без ключа: модель + фрагмент Tone of Voice.
- С **`TAVILY_API_KEY`**: запросы к `https://api.tavily.com/search` с `Authorization: Bearer`.
- **`TAVILY_TOPIC`**: `general` или `news`.
- **`TAVILY_TIME_RANGE`**: `week` / `w` / `day` / `d` и т.д. (см. доку Tavily).
- **`TAVILY_SOCIAL_EXTRA=1`**: второй запрос под SMM / соцсети, выдача склеивается.

### 2) «Скиллы» в боте

Отдельные промпты + запись в `chatHistory` под меткой кнопки:

- `🎯 Идеи заголовков` / `/hooks`
- `🗣 Боли аудитории` / `/audience`
- `✂️ Критика поста` / `/critique` (нужен предыдущий ответ ассистента)

Регистрация: `bot.hears` до `bot.on('text')`, иначе перехватит обычный текст.

### 3) Картинка к посту

- Сжатие смысла в англ. промпт: короткий вызов `callChatMessages`.
- Если задан **`IMAGE_MODEL`** и API = OpenRouter — запрос с `modalities: ['image','text']`, разбор `data:image...;base64` из ответа.
- Иначе URL **Pollinations** (без ключа).

## Cursor «Skills» (IDE)

Этот файл — **проектный skill** в `.cursor/skills/`: подсказывает агенту Cursor, куда смотреть при доработках. Не путать с кнопками «скиллов» в Telegram.

## Деплой

После правок: `git push`, Redeploy сервиса с **Root Directory = copywriter-bot** на Railway. Переменные — как в `.env.example`.
