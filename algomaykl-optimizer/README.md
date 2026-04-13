# AlgoMaykl Optimizer Server v2

Runs the exact same `smartOptimizer.ts` v16 that runs locally in the browser.

## Environment Variables (set in Railway)

```
SUPABASE_URL=https://taihxhfzfkesbbkuqlbr.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your service role key>
PORT=3000
```

## Deploy

### Option 1: Replace existing Railway project files
```powershell
# Copy all files from this folder to your existing Railway project
Copy-Item -Path .\* -Destination C:\Users\micha\algomaykl-optimizer\ -Recurse -Force
cd C:\Users\micha\algomaykl-optimizer
npm install
git add -A
git commit -m "v2: sync optimizer v16 from Lovable"
git push origin main
```

### Option 2: Local test
```bash
npm install
npm run dev
# Test: curl http://localhost:3000/health
```

## API Endpoints

- `GET /health` — returns build version and status
- `POST /api/optimize` — starts optimization (returns immediately, runs in background)

## Payload format (sent by edge function)
```json
{
  "symbolsData": [{ "symbol": "NNE", "candles": [...] }],
  "config": { ... },
  "periodSplit": { "trainStartDate": "...", "trainEndDate": "...", "testStartDate": "...", "testEndDate": "..." },
  "runId": 123,
  "enabled_stages": null
}
```
