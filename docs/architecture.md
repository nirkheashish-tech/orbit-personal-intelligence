# ORBIT Architecture

ORBIT is designed around one simple ownership rule:

> **ORBIT owns the knowledge. The model provides reasoning.**

```text
┌──────────────────────────────────────────────┐
│                  ORBIT UI                    │
│ Home · Boards · Goals · Intelligence · Notes │
└──────────────────────┬───────────────────────┘
                       │ IPC
┌──────────────────────▼───────────────────────┐
│              Electron main process           │
│ persistence · provider routing · secure keys │
└───────────────┬───────────────────┬──────────┘
                │                   │
        ┌───────▼───────┐   ┌──────▼──────────┐
        │    SQLite     │   │  AI providers   │
        │ local source  │   │ Ollama           │
        │ of truth      │   │ LM Studio / OAI │
        └───────────────┘   │ OpenAI · Anthropic│
                            └──────────────────┘
```

## Data model

A board can exist with zero, one, or many goals. Notes and intelligence are durable even when a goal changes. This allows ORBIT to reinterpret accumulated knowledge when the user's objective evolves.

```text
Board
 ├── Goals [0..N]
 ├── Scratchpad
 ├── Intelligence
 ├── Sources
 ├── Ideas / Hypotheses
 └── Synthesis
```

## Intelligence loop

`Set Goal → Explore → Think → Research → Synthesize → Update Goal → Repeat`

The long-term product opportunity is **strategy drift detection**: as evidence accumulates, ORBIT should notice when the user's working hypothesis no longer matches the evidence.
