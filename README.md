# MetroMatrix Realtime (chat + call) — standalone backend for Heroku

This is a **separate, persistent** Node/Express + Socket.IO service that owns
the **chat and call** features. It exists because Vercel serverless can't hold
WebSocket connections; Heroku (persistent dyno) can. Your **main** MetroMatrix
backend stays on Vercel for everything else (auth, bookings, Stripe, uploads).

The whole design rests on one idea:

> **Two processes, one source of truth.** This service and the main backend are
> different servers, but they share **one MongoDB database** and **one JWT
> secret**. That is what makes "a user who registered on the main backend can
> call a provider through this backend" work seamlessly.

---

## The consistency contract (read this first — 3 things must match)

If any of these three differ from your main backend, the cross-backend flow
breaks. Verify all three before deploying.

1. **`MONGODB_URI` — identical (same cluster AND same database name).**
   This service reads the *same* `users`, `providers`, and `bookings` documents
   the main backend created, and writes chat messages / call logs back into the
   same database. A different DB = the provider you're trying to call literally
   doesn't exist here.

2. **`JWT_SECRET` — identical.**
   The user's token is minted by the **main** backend when they log in. This
   service verifies that token on every socket connection and REST call using
   the same secret. Different secret = every request rejected as unauthorized.

3. **The JWT payload shape — matched via `JWT_ID_CLAIM` / `JWT_ROLE_CLAIM`.**
   Whatever your main backend puts inside `jwt.sign({ ... })` (commonly
   `{ id, role }`, sometimes `{ _id }` or `{ userId }`), set `JWT_ID_CLAIM` and
   `JWT_ROLE_CLAIM` in this service's `.env` to match. The auth middleware also
   falls back through `id → _id → userId` automatically.

Two more field mappings to confirm against your real schema (they're read-only
here, but must be named correctly):

- **Booking participant fields.** `src/utils/access.js` and
  `src/models/Booking.js` assume `booking.customer` (the user) and
  `booking.provider`. If your real booking model names them differently, change
  both files.
- **Collection names.** If your existing chat collection isn't `hschatmessages`
  or your bookings aren't `hsbookings`, set the real names in the model files.

**Best practice for zero drift:** copy your real `User.js`, `Provider.js`, and
booking model files from the main backend over the reference stubs in
`src/models/`. This service never calls `.save()` on users/providers (push
tokens are stored with `updateOne`), so copying the real models is safe and will
not trigger your password pre-save hook.

---

## What happens when a user calls a provider (end-to-end trace)

1. User logs in → **main backend (Vercel)** signs a JWT with `JWT_SECRET`,
   creates/loads the user in the **shared DB**.
2. App connects a socket to **this service (Heroku)** with that JWT in
   `handshake.auth.token`.
3. This service verifies the JWT with the **same** `JWT_SECRET`, extracts the
   user id, and the connection is authenticated. *(Breaks here if the secret differs.)*
4. User opens a booking chat → app calls
   `GET {HEROKU_URL}/api/chat/:bookingId`. This service loads the booking from
   the **shared DB**, confirms the user is that booking's customer, and returns
   history + participants **including the provider's phone number**. *(Breaks
   here if the DB differs — the booking/provider wouldn't exist.)*
5. User taps **Ring** → socket `call_ring` → this service verifies membership,
   relays the ring to the provider in the room, writes a **CallLog** row, and
   sends an **Expo push** to the provider's stored device tokens.
6. Provider accepts → dials the user's number (native dialer). CallLog updated
   to `accepted`. **Accountability** = the CallLog rows in the shared DB, which
   both backends and any admin panel can read.

---

## Turning your `Agora` folder into this service

You can't keep the Agora demo as-is — its auth (raw `userId` in the handshake),
its schemas, and its Agora token code all conflict with this design. Two clean
options:

**Option A (recommended): start from this project.** Drop these files into your
`Agora` folder (or a fresh repo), then copy your real model files over the stubs
as described above. Delete whatever Agora-demo files remain.

**Option B: prune the demo in place.** Delete from the Agora folder:

- Anything importing `agora-access-token` / `agora-token` or generating RTC
  tokens (e.g. a `tokenController`, `rtcToken` route) — not used; calling here
  is signalling + native dialer.
- The demo's own auth that trusts a raw `userId`/`name`/`role` from the socket
  handshake — replaced by JWT verification (`src/middleware/auth.js`).
- The demo's Mongo models / connection pointing at `chat-call-demo` — replaced
  by the shared `MONGODB_URI` and your real models.
- Any demo seed/mock data and demo frontend bits.

Keep only: the Express + Socket.IO wiring skeleton (now replaced by this
project's), and any call-screen UI polish you liked (that lives in the app, not
here).

Then remove the dependency: `npm uninstall agora-access-token agora-token` (if
present).

---

## Local run

```bash
cp .env.example .env      # then fill MONGODB_URI + JWT_SECRET from the main backend
npm install
npm run dev               # nodemon, or: npm start
# health check:
curl http://localhost:5000/api/health
```

---

## Deploy to Heroku

```bash
# from this project folder
git init && git add . && git commit -m "realtime backend"
heroku create metromatrix-realtime          # or your chosen app name

# config vars — SAME values as the main backend for the shared two:
heroku config:set MONGODB_URI="<same as main backend>"
heroku config:set JWT_SECRET="<same as main backend>"
heroku config:set SOCKET_CORS_ORIGINS="*"
heroku config:set NODE_ENV=production
heroku config:set EXPO_ACCESS_TOKEN="<optional, from expo.dev>"
heroku config:set JWT_ID_CLAIM=id JWT_ROLE_CLAIM=role   # match your token payload

git push heroku main                          # or: master
heroku logs --tail
```

Heroku specifics that matter:

- The included **`Procfile`** (`web: node server.js`) and `process.env.PORT`
  handling are already correct — Heroku assigns the port.
- **Use a dyno tier that does not sleep.** A sleeping dyno drops every socket
  connection — fatal for incoming calls. The Eco tier sleeps; pick a
  Basic (or higher) dyno so it stays awake 24/7. *(Confirm current tiers and
  pricing on Heroku's dashboard, as these change.)*
- The client's reconnection logic handles Heroku's routine ~daily dyno restart
  gracefully.
- **Single dyno only** for now. If you ever scale to 2+ dynos, enable session
  affinity (`heroku features:enable http-session-affinity`) or add the
  Socket.IO Redis adapter, so socket traffic stays consistent across dynos.

---

## Frontend wiring (the part that's easy to miss)

Your app now talks to **two** backends. Point chat/call at Heroku, everything
else at Vercel.

`.env` (or `eas.json` env):

```dotenv
EXPO_PUBLIC_API_URL=https://metro-matrix-backend.vercel.app/api      # main: auth, bookings, stripe
EXPO_PUBLIC_REALTIME_URL=https://metromatrix-realtime.herokuapp.com  # this service: chat + call
```

Then, in the app:

- **Socket client** connects to `EXPO_PUBLIC_REALTIME_URL` (with the JWT in
  `auth.token`), not the Vercel URL.
- **Chat REST calls** — the history/fallback endpoints
  (`GET /api/chat/:bookingId`, `POST /api/chat/:bookingId/messages`) must be
  sent to `EXPO_PUBLIC_REALTIME_URL/api/...`, **not** your main API base. If you
  have a single `apiRequest` helper hardcoded to the main base, add a second
  base (or a `realtimeRequest` helper) for these routes. Missing this makes chat
  history 404 against Vercel.
- **Push token registration** — `POST /api/users/me/push-token` also goes to
  `EXPO_PUBLIC_REALTIME_URL`, because this service is what sends the pushes and
  it reads tokens from the shared DB.

Everything else in the app (login, bookings, wallet) keeps using
`EXPO_PUBLIC_API_URL`.

---

## Endpoints this service exposes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | uptime check |
| GET | `/api/chat/:bookingId` | Bearer | history + participants (incl. phone) |
| POST | `/api/chat/:bookingId/messages` | Bearer | send message (REST fallback) |
| POST | `/api/users/me/push-token` | Bearer | register Expo device token |

## Socket events

Client → server: `join_booking`, `leave_booking`, `send_message`, `typing`,
`mark_read`, `call_ring`, `call_accept`, `call_decline`, `call_end`.
Server → client: `joined_booking`, `new_message`, `typing`, `read`,
`call_ring`, `call_accept`, `call_decline`, `call_end`.

All are authorized against booking membership server-side; a client that knows a
`bookingId` but isn't a participant is silently ignored.
# MetroMatrix-Realtime
