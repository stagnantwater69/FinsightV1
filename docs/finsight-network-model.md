# FinSight Network Model

The diagram below reflects the system implemented in this repository.

```mermaid
flowchart LR
    OWNER[Small-Business Owner]

    subgraph CLIENTS[User devices]
        WEB[React Web App]
        MOBILE[Expo Mobile App]
    end

    subgraph APP[FinSight application environment]
        EDGE[HTTPS Reverse Proxy]
        API[Express / TypeScript API]
        WORKERS[In-process OCR and Analysis Workers]
        OCR[Local OCR\nSharp + Tesseract.js]

        EDGE --> API
        API <--> WORKERS
        WORKERS --> OCR
    end

    subgraph SUPABASE[Supabase cloud services]
        AUTH[Supabase Auth]
        DB[(PostgreSQL Database)]
        STORAGE[Supabase Storage]
    end

    subgraph OPTIONAL[Optional external AI services]
        GEMINI[Google Gemini]
        OPENROUTER[OpenRouter]
    end

    OWNER --> WEB
    OWNER --> MOBILE
    WEB -->|HTTPS JSON / multipart| EDGE
    MOBILE -->|HTTPS JSON / multipart| EDGE
    WEB -->|TLS; public anon key| AUTH
    MOBILE -->|TLS; public anon key| AUTH
    API -->|TLS; token verification / admin operations| AUTH
    API -->|TLS; Prisma pooled connection| DB
    WORKERS -->|Durable job state and results| DB
    API -->|TLS; service role| STORAGE
    WORKERS -.->|When configured| GEMINI
    API -.->|When configured| GEMINI
    API -.->|Fallback when configured| OPENROUTER
    WORKERS -.->|Fallback when configured| OPENROUTER
```

## Interpretation

- FinSight has one implemented application role: **Small-Business Owner**. An
  application-administrator role is not implemented.
- The ISP or public internet transports encrypted traffic; it is not an
  application component and does not directly connect the database, OCR, or
  cloud storage.
- Web and mobile clients call the API through HTTPS and also communicate with
  Supabase Auth for user sessions.
- The API is the application boundary for PostgreSQL and Storage access. Client
  applications do not connect directly to application tables or storage using
  privileged credentials.
- OCR runs locally in the backend worker process. Gemini vision may assist with
  difficult receipts when configured; Gemini and OpenRouter are also optional
  providers for AI-assisted explanations.
- Receipt and anomaly jobs are durable in PostgreSQL, but the workers currently
  run inside the backend process rather than on a separate server.

