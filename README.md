# metromatrix-realtime

Chat + call for MetroMatrix. A persistent Node/Express + Socket.IO service on
Heroku, deployed separately from the main backend because Vercel is serverless
and cannot hold a WebSocket open.

**Live:** https://metromatrix-realtime-1d7dadda1082.herokuapp.com

---

## The consistency contract

The two backends **never call each other**. They stay consistent by sharing
exactly two values, which must be byte-identical to the main backend's:

| Var | Why |
|---|---|
| `MONGODB_URI` | Same cluster **and** same database (`metromatrix`) |
| `JWT_SECRET` | Main signs the token at login; this service verifies it |

That is the whole integration. A user logs in against the main API, and the
token they already hold is accepted here as-is.

Because nothing enforces that the two schemas stay aligned, `src/utils/verifySchema.js`
samples every shared collection at boot and warns loudly on drift:

```
[schema] shared collections verified against the main backend
```

## Ownership

| Collection | Owner | Notes |
|---|---|---|
| `users`, `providers`, `doctors`, `hsbookings`, `appointments` | **main** | read-only here; `autoIndex` is off so deploys never mutate them |
| `hschatmessages` | **shared** | both services read and write it — field names must match exactly |
| `calllogs` | this service | |

The only write this service makes to a main-owned collection is
`expoPushTokens`, via `updateOne`/`$addToSet` — never `.save()`.

## Rooms

A room is polymorphic. `roomType` selects which:

| roomType | room id | participants |
|---|---|---|
| `homeservice` | `HSBooking._id` | `customer` (User) ↔ `provider` (Provider) |
| `healthcare` | `Appointment._id` | `patientId` (User) ↔ `doctorId` (**Doctor**) |

`roomType` is a **hint**, not a trust boundary — the happy path is one lookup,
and a missing or wrong hint just costs one extra query. Old clients that send
only a `bookingId` still work.

### The Doctor ↔ Provider identity hop

The main backend mints one kind of provider token. **A doctor signs in as
`userType: 'provider'` and their token's `id` claim is their `Provider._id`** —
but `Appointment.doctorId` is a `Doctor._id`, a different document in a
different collection, linked by `Doctor.providerId`.

So a doctor is matched by `Doctor.findOne({ providerId: <token id> })`, and
**everywhere downstream is keyed by `Provider._id`** — push tokens, `CallLog`
participants, the busy map — because that is the id their socket connects with.
Keying anything by `Doctor._id` silently fails to match and calls never route.

The doctor's phone number also lives on the Provider document; `Doctor` has no
phone field at all.

**Role is always derived from room membership in the database, never from the
JWT.** The token's `userType` cannot distinguish a doctor from a home-service
provider. It is used in exactly one place: choosing `User` vs `Provider` for
push-token registration, which has no room context.

---

## REST

All routes require `Authorization: Bearer <main-issued access token>`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | 503 when Mongo is down |
| `GET` | `/api/chat/:roomId?roomType=&before=&limit=` | Cursor pagination; returns `hasMore`/`nextCursor` |
| `POST` | `/api/chat/:roomId/messages` | Body `{ text }` or `{ message }` |
| `POST` | `/api/users/me/push-token` | `{ token }` — Expo format validated |
| `DELETE` | `/api/users/me/push-token` | Call on logout |

`GET /api/chat/:roomId` returns a **superset** of the main backend's older
`/api/chat/:bookingId` response, so repointing a client is a transparent swap:
`bookingId`, `participants.user`, `participants.provider` and the message DTO
are all byte-compatible. Added on top: `roomId`, `roomType`, `role`,
`phoneNumber` on participants, and pagination.

Participants carry phone numbers because calling hands off to the native dialer.
`expoPushTokens` is stripped at the boundary and never leaves the server.

---

## Socket events

Handshake: `auth: { token }`. Every room-scoped event is **separately**
authorized against live room membership — a non-participant is refused, and
never learns whether the room exists.

### Client → server

| Event | Payload | Ack |
|---|---|---|
| `join_booking` | `{ roomId, roomType? }` | `{ success, data: { roomType, role } }` |
| `leave_booking` | `{ roomId }` | — |
| `send_message` | `{ roomId, roomType?, text, clientMsgId? }` | `{ success, data: <message DTO> }` |
| `typing` | `{ roomId, roomType?, isTyping }` | — |
| `mark_read` | `{ roomId, roomType? }` | `{ success }` |
| `call_ring` | `{ roomId, roomType? }` | `{ success, data: { callId, callee } }` or `{ success:false, reason:'busy'\|'rate_limited'\|'forbidden'\|'self' }` |
| `call_accept` | `{ callId, roomId }` | `{ success }` |
| `call_decline` / `call_end` | `{ callId, roomId }` | `{ success }` |

`bookingId` is accepted as an alias for `roomId` everywhere.

### Server → client

| Event | Target | Payload |
|---|---|---|
| `new_message` | room | message DTO (`{ id, text, sender, timestamp, status }`) |
| `typing` | room (others) | `{ roomId, bookingId, userId, isTyping }` |
| `messages_read` (+ legacy `read`) | room | `{ roomId, by }` |
| `call_ring` | callee's personal room + conversation room | `{ callId, roomId, roomType, from: { id, role, name, phoneNumber } }` |
| `call_accept` | room | `{ callId, from, peer: { phoneNumber } }` |
| `call_decline` / `call_end` | room | `{ callId, from, reason }` |
| `call_missed` | both parties | `{ callId, roomId }` |
| **`call_busy`** | **caller only** | `{ roomId, calleeId }` |
| `token_expired` | socket | sent before disconnecting an expired session |
| `server_shutdown` | all | `{ reconnectInMs }` — dyno cycling |

`call_busy` goes to the caller alone; broadcasting it would tell the busy callee
about a ring they never received.

Messages are emitted as **DTOs, not raw Mongoose documents** — the app dedupes
on `id`, and a raw document has `_id`.

---

## Calling: signalling only

`ring / accept / decline / end` coordinate the two apps. **The audio is the
phone's native dialer** (`tel:`). No WebRTC, no Agora, no Twilio, no native
modules — the app stays in Expo's managed workflow.

### Busy signal — and its one real limitation

Busy state begins at **ring**, not accept (otherwise two callers could ring the
same person simultaneously). Tracked in memory, with a `CallLog` fallback for
when a socket died mid-call, bounded by a staleness floor so a crash cannot wedge
someone busy forever. A boot sweeper and the SIGTERM path close out orphans.

**This is app-level busy only.** It cannot detect that the callee is on an
ordinary phone call placed outside the app — including the native leg of a call
this service brokered, if the app is killed after the dialer takes over. That is
an unavoidable consequence of the native-dialer design: the OS does not report
system call state to a React Native app without CallKit / ConnectionService.
When the callee is on an unrelated cellular call the ring still goes through and
the carrier handles it.

Unanswered rings are marked `missed` after 30s.

---

## Operations

```bash
npm install
npm start                 # boots, verifies the shared schema, listens
npm run ensure-indexes    # deliberate index creation (see below)
npm run verify-token "<a real access token>"   # proves the shared secret matches
```

**Indexes are never created on boot.** `autoIndex` is off so a dyno restart can
never mutate collections the main backend owns. Run `npm run ensure-indexes`
once after deploy; it adds `{ booking: 1, _id: -1 }` (backs the `?before=`
cursor) and the sparse-unique `{ booking: 1, clientMsgId: 1 }` to
`hschatmessages`, plus this service's own `calllogs` indexes.

### Deploy

```bash
git push heroku main
heroku logs --tail --app metromatrix-realtime
curl https://metromatrix-realtime-1d7dadda1082.herokuapp.com/api/health
```

### Dyno tier

**Use Basic or higher — never Eco.** An Eco dyno sleeps after 30 minutes of
inactivity, which drops every WebSocket and makes incoming calls impossible
until someone hits the app over HTTP. The app is currently on **Basic**.

**Single dyno only.** The busy-call map and the rate limiter are in-memory, and
Socket.IO has no Redis adapter here. At 2+ dynos a callee connected to another
dyno reads as free, and each dyno grants its own rate-limit allowance. Scaling
out requires `@socket.io/redis-adapter` plus moving both maps to Redis.

## Environment

See `.env.example`. `.env` is gitignored and must never be committed.
