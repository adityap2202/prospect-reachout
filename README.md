# GivingPi Donor Prospecting Tool (Spec v2)

## Local dev

1. Fill `.env` with:
   - `ANTHROPIC_API_KEY`
   - `TAVILY_API_KEY`
2. Install deps:

```bash
npm install
npm install --prefix client
```

3. Run:

```bash
npm run dev
```

- Frontend: `http://localhost:5173/`
- Backend: `http://localhost:3001/`

## Production (single Railway service)

- `npm run build` builds the React app to `client/dist`.
- `node server/server.js` serves the API and (if present) `client/dist` as static assets.

Persist storage by mounting a Railway Volume to `/app/data` and setting:

- `DATA_DIR=/app/data`

### Railway note (better-sqlite3)
This project uses `better-sqlite3` (native module). Railway/Nixpacks must build with **Node 20**.
This repo includes `.nvmrc` and `nixpacks.toml` to pin Node 20 and provide build tools.

If Railway still fails with `npm: command not found`, deploy using the included `Dockerfile` (Node 20).

