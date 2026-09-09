# AI Providers

ORBIT keeps provider routing separate from the knowledge store.

| Provider | Runtime | Live web search |
|---|---|---|
| LM Studio / OpenAI-compatible | Local | No |
| Ollama | Local | No |
| OpenAI | Cloud API | Yes, for research mode |
| Anthropic | Cloud API | Not wired into research mode yet |

## LM Studio

Start LM Studio's local server and enter the server URL shown by LM Studio in **Settings → AI Provider**. ORBIT normalizes the URL and calls:

```text
POST <base-url>/v1/chat/completions
```

The model field should match the model identifier exposed by LM Studio.

## Ollama

ORBIT uses Ollama's native chat endpoint:

```text
POST <base-url>/api/chat
```

## API keys

OpenAI and Anthropic keys are stored outside SQLite. Electron `safeStorage` is used when available; otherwise ORBIT falls back to a local key file. Do not commit keys to the repository.
