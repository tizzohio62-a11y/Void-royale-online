# VOID ROYALE — online deployment pack

This pack contains the game page and its Node.js matchmaking/WebSocket server.

## Deploy on Render

1. Create a GitHub repository for this project.
2. Upload **all five files** from this folder to the repository root:
   - `index.html`
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `README.md`
3. In Render, choose **New → Blueprint** and connect that GitHub repository.
4. Render reads `render.yaml`. Create/deploy the `void-royale` web service.
5. Wait for deployment to finish. Open the Render service URL (it will look like
   `https://your-service-name.onrender.com`).
6. Open the game from that Render URL, not the GitHub Pages URL, for this
   simplest same-origin setup.

## Why this pack serves the game and server together

The game already contains WebSocket matchmaking code. Its `ONLINE_SERVER` value
is blank, so it automatically derives `wss://` from the page's own HTTPS host.
The Node server serves `index.html` and accepts WebSocket upgrades on that same
host. Keeping the game page and server together means no separate WebSocket URL
needs to be pasted into the game.

The server requires Node.js 18 or newer and has no external npm dependencies.
Render may spin down an inactive free service; the first visit after inactivity
can take a little while to wake it up.

## Important

- The game file is deliberately named `index.html` because `server.js` looks
  for that exact filename.
- Keep `server.js`, `package.json`, `render.yaml`, and `index.html` in the
  repository root together.
- The server's matchmaking starts matches with 2–4 players. It waits briefly
  for additional players before starting a smaller match.
- This is an initial multiplayer server, not a production-hardened competitive
  backend. Do not treat client-reported movement, damage, or wins as secure.
