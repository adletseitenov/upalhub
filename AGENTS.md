<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Правила проекта U-Pal

- **Перед началом работы:** `git pull origin main` — над репо работают несколько агентских сессий (Адлет + Дияр).
- **Obsidian-журнал (обязательно):** после каждой КРУПНОЙ вехи — завершение этапа/задачи плана, архитектурное решение, договорённость с командой — допиши запись сверху в `C:\Users\adlet\OneDrive\Документы\Projects\upal\Журнал вех.md` (дата + 2–4 предложения). Только вехи, не каждый коммит. Если путь недоступен (другая машина/облачная сессия) — пропусти молча.
- LLM — только через адаптер `src/lib/llm` (OpenRouter); прямой Claude API/Anthropic SDK не подключать. Веб-поиск — только `src/lib/search`.
- i18n RU/KK на каждом экране; ключи локалей идентичны (пиннится тестом).
- Дизайн делает партнёр основателя: нейтральный Tailwind-каркас, без самодеятельных палитр и шрифтов.
- Секреты — только в `.env.local`; в репо — `.env.example`.
