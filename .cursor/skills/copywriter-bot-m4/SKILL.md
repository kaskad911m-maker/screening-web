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

- Без ключа: модель + фрагмент Tone of Voice; в user-блоке есть seed для разнообразия.
- С **`TAVILY_API_KEY`**: запросы к `https://api.tavily.com/search` с `Authorization: Bearer`.
- **`NICHE_HINT`** + **`TREND_FOCUS`**: строка для ниши и доп. угол в запросах Tavily и в системном промпте трендов.
- **`TAVILY_TOPIC`**: `general` или `news`.
- **`TAVILY_TIME_RANGE`**: `week` / `w` / `day` / `d` и т.д. (см. доку Tavily).
- **`TAVILY_SOCIAL_EXTRA=1`**: второй запрос под SMM / соцсети, выдача склеивается.

### 2) «Скиллы» в боте

Отдельные промпты + запись в `chatHistory` под меткой кнопки:

- `🎯 Идеи заголовков` / `/hooks`
- `🗣 Боли аудитории` / `/audience`
- `✂️ Критика поста` / `/critique` — два шага: разбор, затем **исправленный пост** (нужен предыдущий ответ ассистента)

Регистрация: `bot.hears` до `bot.on('text')`, иначе перехватит обычный текст.

### 3) Картинка к посту

- Текст поста для обложки хранится в **`lastPostForImageByUser`**: обновляется при каждом `generatePost` и после блока «исправленный пост» в критике.
- Кнопка «Картинка» → инлайн **форматы** (`ifm:WxH`) → Pollinations или OpenRouter `IMAGE_MODEL`.
- Промпт: `buildImagePromptFromPost` (англ. сцена по смыслу поста; **`stripBoldMarkers`** на тексте) + пропорция.

### 4) Пост в чате

- Модель помечает фразы `**…**` (см. `baseSystemPrompt`). Отправка: **`replyPostChunks`** → HTML `<b>` при **`POST_BOLD_HTML=1`** (по умолчанию), иначе plain.

## Cursor «Skills» (IDE)

Этот файл — **проектный skill** в `.cursor/skills/`: подсказывает агенту Cursor, куда смотреть при доработках. Не путать с кнопками «скиллов» в Telegram.

## Доступ

- **`ALLOWED_TELEGRAM_USER_IDS`** (опционально): если задан — бот отвечает только этим numeric Telegram id; иначе открыт для всех. Не снимает оплату API с владельца, только ограничивает круг пользователей.

## Деплой

После правок: `git push`, Redeploy сервиса с **Root Directory = copywriter-bot** на Railway. Переменные — как в `.env.example`.
