# Dangerous Writing — Multiplayer

A Kahoot-style chaos writing game. Everyone joins a room with a 4-letter code and starts writing. If **any** player stops typing for 5 seconds, **everyone's** text gets wiped.

## Run locally

```bash
cd /home/harry/dangerous-multiplayer
npm install
npm start
```

Open http://localhost:3000

- Host opens the index page → "Host a new room" → display the code.
- Players go to http://localhost:3000 from any device on the same network, enter the code + a name.
- Host hits "Start game" → everyone's textarea unlocks.
- Top of each player's screen shows the slowest player's remaining time and name. Top bar flashes red when the room is in danger.

## Deploy

This is a single-process Node app, deployable to Fly.io, Render, Railway, Heroku-style platforms. The server binds to `process.env.PORT`. For LAN play just port-forward 3000 or use `tailscale`/`ngrok`.

## Tunables

In `server.js`:

- `DOOM_MS` — how long without a keystroke before everyone gets reset (default 5000).
- `TICK_MS` — server tick rate for the doom check (default 200).
