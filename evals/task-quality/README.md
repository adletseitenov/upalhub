# Task quality eval (Stage 2.5, Task 9)

Живой eval (вне CI, паттерн `evals/live-smoke`): проверяет качество
генерации заданий `generateForBucket` (`src/features/tasks/generate.ts`) на
трёх фикстурах-профилях (ЕНТ-математика kk/text, IELTS Listening en/audio,
NIS-вариант ru/text гуманитарная секция) и сравнивает три модели генерации:
`google/gemini-2.5-flash`, `google/gemini-2.5-pro` и `qwen/qwen-plus`
(плоского id на OpenRouter нет — probe-фолбэк на `qwen/qwen3.7-plus`,
фактически использованный id пишется в отчёт).

Судья — **всегда** `google/gemini-2.5-pro` (постоянный эталон, промпт в
файле, отдельный от генераторского), проверяет каждое сгенерированное
задание по 4 бинарным критериям: `onTopic`, `keyCorrect`, `languageOk`,
`passageAnswerable`. `languageOk` дополнительно разбивается по фикстурам —
казахская (`ent-math-kk`) критична основателю (потенциально слабое место
qwen-линейки).

Repo — in-memory fake (`fakeRepo()` в файле теста), БД не участвует. Тратит
реальные LLM-вызовы через `src/lib/llm` (OpenRouter); ключи — из
`.env.local` (`process.loadEnvFile`).

## Запуск

```
npm run eval:tasks
```

Таймаут теста — 600 000 мс (3 модели × 3 бакета генерации + судейство
каждого задания). Отчёт печатается в консоль и пишется в
`evals/task-quality/out/report.json`; выводы для решения основателя — в
`docs/decisions/generation-model.md`.

## Gate

Единственный hard-assert — `flash.onTopicRate >= 0.8` (цель плана после
T2-промптов секционной привязки). Остальные метрики (всех моделей) —
`console.warn` при <80%, замер первого прогона, не fail. Провал одного
судейского вызова не роняет модель: задание уходит в `judgeErrors` и
исключается из знаменателя.
