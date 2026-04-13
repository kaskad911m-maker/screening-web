-- Шаг 1 (модуль 3, урок 4): таблицы в Supabase (PostgreSQL).
-- Как запускать: Supabase → SQL Editor → New query → вставить весь файл → Run.

-- Мастера (у кого записываются клиенты)
CREATE TABLE IF NOT EXISTS public.masters (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  telegram_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Записи из Mini App (кнопка «Записаться»)
CREATE TABLE IF NOT EXISTS public.bookings (
  id BIGSERIAL PRIMARY KEY,
  master_slug TEXT NOT NULL REFERENCES public.masters (slug),
  source TEXT NOT NULL,
  birth_date TEXT,
  gender TEXT,
  personality_number INTEGER,
  destiny_number INTEGER,
  archetype TEXT,
  telegram_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Заявки с сайта (форма на index.html)
CREATE TABLE IF NOT EXISTS public.leads (
  id BIGSERIAL PRIMARY KEY,
  master_slug TEXT NOT NULL REFERENCES public.masters (slug),
  source TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_channel TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Стартовая строка — как в локальной SQLite
INSERT INTO public.masters (slug, display_name, telegram_username)
VALUES ('marina', 'Марина Филимонова', 'marina_zena3')
ON CONFLICT (slug) DO NOTHING;

-- Удобные индексы для списков «последние сверху»
CREATE INDEX IF NOT EXISTS idx_bookings_created ON public.bookings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_created ON public.leads (created_at DESC);

-- Права для шага 1 (учеба): таблицы доступны через Table Editor под твоим аккаунтом.
-- Когда подключишь API (шаг 2 урока), включишь RLS и политики — см. BACKEND-PLAN.md.
