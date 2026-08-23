# AI Chat — conversations, history, and sidebar behaviour

Date: 2026-08-23
Status: approved, ready for implementation
Scope: `backend/`, `web/`. Mobile is explicitly out of scope for this pass.

## Problem

"Ask FinSight" is not a chat application. It is a per-module drawer
(`web/src/components/AskFinSightDrawer.tsx`) instantiated separately on the
Dashboard and the three Insights screens. Each instance shows an implicit,
append-only log: "the last N `AIInteraction` rows for
(userId, businessProfileId, module)". There is no conversation entity, no
title, no way to start a second thread, and no way to delete or rename
anything. State is local `useState` per drawer instance, so it resets on every
navigation.

Owners cannot keep two lines of enquiry apart, cannot return to something they
asked last week, and cannot get out of a thread that has drifted.

## Decisions taken before design

These were settled with the user and are not re-opened here:

1. **Unified, app-wide chat.** Conversations are not permanently bound to a
   module. The originating module is captured once, as metadata, so the AI
   knows where the question started — but the conversation stays reachable and
   complete from anywhere.
2. **Web only.** `POST /ai/ask` and `GET /ai/history` keep their current
   behaviour unchanged so mobile's `AskFinSight.tsx` is untouched.
3. **No migration.** Existing `AIInteraction` rows are left alone. Conversation
   history starts empty for existing users.
4. **Dedicated page, not an overlay.** A new `/ai-chat` route inside the
   authenticated app shell.
5. **Client-side titles.** The title is the first user message trimmed at a word
   boundary. No extra model call.
6. **New `Conversation` + `ChatMessage` tables.** `AIInteraction` is not
   extended — the two have different semantics and mobile still depends on the
   old one.

## Layout: two rails, not one

The app already has a collapsible sidebar (`AppShell.tsx`, 256px / 72px) that
carries the FinSight logo, the business switcher, and the main navigation. The
AI Chat page adds a **second, narrower rail** holding New Chat and Chat
History, between the app sidebar and the message column.

Collapsing the app nav rail and collapsing the chat history rail are separate
controls with separate persisted state. This keeps global navigation reachable
from the chat page — folding chat history into the app nav would have meant
either stranding the user with no way out or stacking two unrelated lists in
one 256px column, which is the "overcrowded sidebar" the brief warns against.

```
>= 1024px   [ app nav 256/72 ][ chat history 264/0 ][ messages, fills rest ]
<  1024px   [ topbar + bottom nav ][ messages ]   chat history = overlay drawer
```

## Data model

`backend/prisma/schema.prisma`, following the existing `Table_Column` mapping
convention.

```prisma
model Conversation {
  id                Int      @id @default(autoincrement()) @map("Conversation_ID")
  userId            Int      @map("User_ID")
  businessProfileId Int      @map("BusinessProfile_ID")
  title             String   @map("Conversation_Title") @db.VarChar(120)
  originModule      String   @map("Conversation_OriginModule") @db.VarChar(50)
  createdAt         DateTime @default(now()) @map("Conversation_DateCreated")
  lastMessageAt     DateTime @default(now()) @map("Conversation_LastMessageAt")

  user            User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  businessProfile BusinessProfile @relation(fields: [businessProfileId], references: [id], onDelete: Cascade)
  messages        ChatMessage[]

  @@index([userId, businessProfileId, lastMessageAt])
  @@map("Conversation")
}

model ChatMessage {
  id             Int      @id @default(autoincrement()) @map("Message_ID")
  conversationId Int      @map("Conversation_ID")
  role           String   @map("Message_Role") @db.VarChar(10)   // "user" | "assistant"
  content        String   @map("Message_Content") @db.VarChar(2000)
  createdAt      DateTime @default(now()) @map("Message_Timestamp")

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
  @@map("ChatMessage")
}
```

`originModule` is a `VarChar(50)` validated against the existing
`INTERACTION_MODULES` union, matching how `AIInteraction.module` is handled.
`ChatMessage.content` is 2000 rather than `AIInteraction`'s 1000 because the
same truncation guard now has to hold both halves of an exchange in one column.

`onDelete: Cascade` on `conversationId` is what makes conversation delete a
single statement.

## API

All routes are on the existing `aiRouter` (`requireAuth` already applied) and
every query is scoped to `userId` **and** an ownership check on
`businessProfileId`, per the ownership-isolation rule. Routes that call a
billed model reuse the existing `LIMITS.ASK_BURST` / `LIMITS.ASK_HOURLY` pair.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/ai/conversations?businessProfileId=&limit=` | List, newest `lastMessageAt` first. No messages. |
| `GET` | `/ai/conversations/:id` | One conversation with its full message list, oldest first. |
| `POST` | `/ai/conversations` | Lazy create + first exchange. Rate-limited. |
| `POST` | `/ai/conversations/:id/messages` | Continue an existing conversation. Rate-limited. |
| `PATCH` | `/ai/conversations/:id` | Rename (`{ title }`). |
| `DELETE` | `/ai/conversations/:id` | Delete, cascading to messages. |

`POST /ai/conversations` body:
`{ businessProfileId, originModule, question, title?, context? }`.
The title is derived server-side from `question` when omitted, so the stored
title can never be empty regardless of client.

Both `POST` routes return the same shape:

```ts
{
  conversation: { id, title, originModule, createdAt, lastMessageAt },
  userMessage:      { id, role: "user",      content, createdAt },
  assistantMessage: { id, role: "assistant", content, createdAt },
  provider: "gemini" | "openrouter" | "unavailable",
  detectedAmount: number | null,
}
```

`provider` and `detectedAmount` are carried through unchanged from the existing
ask path so the page can show the same "AI is unreachable, this is a
placeholder" banner and the same parsed-amount disclosure the drawer showed.

### Context building

The conversation service reuses `buildModuleContext` from `aiContext.service`
with the conversation's stored `originModule`, and threads the last
`HISTORY_TURNS_FOR_CONTEXT` (6) turns of **this conversation** — not of the
module log — into `askFinSight`. Context is still rebuilt server-side from
fresh data on every message, which is the property the current drawer's comment
block exists to protect.

`/ai/ask`, `/ai/history`, `/ai/purchase-review` and `/ai/suggest-category` are
not modified.

## Web

### New files

- `web/src/pages/AiChat.tsx` — the page: reads `location.state`, owns the
  active-conversation state, renders rail + message column.
- `web/src/components/aiChat/ChatHistoryRail.tsx` — New Chat button, grouped
  conversation list, collapse control, responsive overlay behaviour.
- `web/src/components/aiChat/ConversationItem.tsx` — one row plus its
  Rename/Delete menu.
- `web/src/components/aiChat/ChatMessages.tsx` — welcome state, bubbles,
  starter chips, error/unavailable banners. Bubble styling is lifted verbatim
  from the drawer so the visual language does not change.
- `web/src/lib/conversationGroups.ts` — pure date-bucketing helper
  (Today / Yesterday / Previous 7 Days / Previous 30 Days / Older). Unit-tested
  on its own.

### Changed files

- `App.tsx` — lazy `/ai-chat` route inside `AuthenticatedLayout`.
- `AppShell.tsx` — logo becomes the expand control when collapsed (below).
- `AskFinSightDrawer.tsx` — the drawer component is deleted; `AskFinSightButton`
  survives, now navigating to `/ai-chat` with
  `{ state: { originModule, initialQuestion? } }` instead of taking an
  `onClick`. Its FAB art, portal, and clearance spacer are unchanged.
- `Dashboard.tsx`, `ExpenseInsight.tsx`, `SpendingImpact.tsx`,
  `FlaggedRecords.tsx` — drop the drawer instance and its `open` state; keep
  rendering `<AskFinSightButton />`. Their "explain this" actions pass their
  built question through as `initialQuestion`.
- `web/src/lib/types.ts` — `Conversation`, `ChatMessage`, `ConversationDetail`,
  `ChatSendResponse`.

### Behaviour

**Lazy creation.** New Chat sets active conversation to `null` and clears the
message list. Nothing is persisted. The first send calls
`POST /ai/conversations`; the returned id becomes active and the row is
prepended to the list. An abandoned empty chat leaves no trace.

**Switching.** Clicking a row fetches `GET /ai/conversations/:id` and replaces
the message list. Already-loaded conversations are served from an in-page cache
keyed by id, so switching back is instant and nothing re-fetches. No navigation
occurs — the route does not change.

**Sidebar/chat independence.** The rail's collapsed flag lives in its own state
(persisted to `localStorage`), read by nothing that touches conversation state.
Toggling it cannot start, clear, or reload a conversation.

**Origin context.** `location.state.originModule` seeds only the *next* created
conversation and the welcome copy. Once a conversation exists, its stored
`originModule` governs. Arriving at `/ai-chat` from the nav with no state
defaults to `Dashboard`.

**Responsive.** At `< 1024px` the rail is a left overlay drawer with a scrim,
closed by default, trapping focus while open and closing on Escape — matching
how the existing drawer already behaves. It never squeezes the message column.

### AppShell sidebar change

Collapsed today, `AppShell` renders a full-width "Expand sidebar" button in its
own row above the logo. That row is removed. The logo becomes the control:

- Default: the `F` badge, as now.
- Hover / focus: cross-fades to `IconSidebar` over 150ms with a
  "Open sidebar" tooltip, using the existing `RailTip`.
- Click: expands.

Expanded, nothing changes — the logo is a link to `/dashboard` and the collapse
button sits beside it, already "connected to the branding" as the brief asks.
The swap is a two-layer cross-fade on opacity, so no layout shift occurs and
`prefers-reduced-motion` degrades it to an instant swap.

Accessibility: collapsed, the element is a `<button aria-label="Open sidebar"
aria-expanded={false}>`, not a link — a control that expands a region should
not be announced as navigation. The `/dashboard` link is still reachable from
the nav list below.

## Testing

- **Backend unit** — title derivation and truncation; context threading uses the
  conversation's own turns.
- **Backend integration** (`finsight_test` container) — ownership isolation on
  all six routes (another user's conversation id returns 404, never 403 with a
  body); cascade delete removes messages; `lastMessageAt` advances on send;
  rename rejects empty and over-length titles.
- **Backend contract** — `/ai/ask` and `/ai/history` responses are byte-identical
  to before, guarding mobile.
- **Web unit** — `conversationGroups.ts` bucketing across boundaries
  (23:59 yesterday, exactly 7 days, exactly 30 days).
- **Web component** — New Chat does not create a record until first send;
  switching conversations preserves messages; toggling the rail leaves the
  active conversation and its messages untouched; rename and delete update the
  list.
- The existing `AskFinSightDrawer.test.tsx` is replaced by tests against the new
  page rather than deleted outright, so the behaviours it covered (history
  loads, unavailable banner, starter chips prime the input) keep coverage.

## Out of scope

Mobile. Streaming responses. Search over conversations. Sharing or exporting a
conversation. Pinning or archiving. Any change to how answers are generated.
