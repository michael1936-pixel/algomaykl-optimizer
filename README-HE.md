# תיקון Railway 502 — כפיית Node 22

הבעיה: Railway מחזיר 502 כי השרת לא עונה. לפי הלוג הקודם, השרת קורס בעלייה בגלל Node 20 ללא WebSocket מובנה.

ה-ZIP הזה כולל:
- `.nvmrc` עם `22`
- `nixpacks.toml` שמכריח את Nixpacks/Railway להשתמש ב-Node 22
- `apply-railway-node22-fix.ps1` שמעדכן גם את `package.json` ומוסיף `engines.node >=22`

## פקודות מוכנות — PowerShell

```powershell
cd C:\Users\micha\algomaykl-optimizer
Expand-Archive -Path $HOME\Downloads\railway-node22-nixpacks-fix.zip -DestinationPath . -Force
.\apply-railway-node22-fix.ps1
git add package.json .nvmrc nixpacks.toml
git commit -m "fix: force Railway to build with Node 22"
git push origin main
```

## בדיקה אחרי 2-3 דקות

```powershell
curl https://selfless-kindness-production-0003.up.railway.app/health
```

אם עדיין יש 502 אחרי ה-push:
1. ב-Railway פתח את השירות `algomaykl-optimizer`.
2. Settings → Source: ודא שה-repo הוא `michael1936-pixel/algomaykl-optimizer`, branch הוא `main`, ו-Auto Deploy פעיל.
3. בצע Manual Redeploy.
4. אם צריך: Variables → הוסף `NIXPACKS_NODE_VERSION` עם הערך `22`, ואז Redeploy.
