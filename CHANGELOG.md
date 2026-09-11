# Changelog

## 0.1.0 — 2026-09-09

- Added local-first SQLite persistence.
- Added persistent boards with optional goals, scratchpad notes, intelligence, and synthesis.
- Added Home command center and Boards navigation.
- Added board creation, editing, and deletion.
- Added Ollama support.
- Added LM Studio / OpenAI-compatible local provider support.
- Added OpenAI and Anthropic API providers.
- Added provider connection testing.
- Added encrypted local storage for cloud API keys when Electron safeStorage is available.
- Added README product documentation and UI mockups.


## 0.2.0 — 2026-09-10 — Automatic Intelligence

- Added meaningful starter goals to the three built-in example boards (AI, Personal Investing, Photography & Video).
- Starter goals are seeded once only and never overwrite existing user goals.

- Added an Electron main-process background research scheduler.
- Added global automatic-research enable/disable and cadence controls.
- Added per-board automatic research enable/disable.
- Automatic research uses goals, description, scratchpad, prior intelligence, and living synthesis to decide what to investigate; users do not supply research questions.
- Meaningful automatic findings are persisted and followed by a synthesis refresh.
- Preserved LM Studio, Ollama, OpenAI, and Anthropic providers.
- On-demand “Research now” remains unchanged.
