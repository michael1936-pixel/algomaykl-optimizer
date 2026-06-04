============================================================
RAILWAY SERVER FIX — Node 22 + Optimizer Sync
============================================================

מטרה: לדחוף ל-repo הנכון (algomaykl-optimizer) את:
  1. Node 22 config (.nvmrc + nixpacks.toml)
  2. עדכון package.json עם engines.node >= 22
  3. סנכרון 10 קבצי האופטימייזר ל-src/optimizer/

============================================================
הוראות (PowerShell - paste-and-run בלוק אחד):
============================================================

ראה את הבלוק שהאיג'נט שלח לך בצ'אט.
הוא יבצע אוטומטית:
  - clone/cd לתיקייה הנכונה
  - אימות שה-remote הוא algomaykl-optimizer (לא frontend!)
  - פריסת הקבצים
  - commit + push
  - הדפסת ה-remote URL הסופי לאישור ויזואלי

אחרי הריצה:
  1. פתח: https://github.com/michael1936-pixel/algomaykl-optimizer/commits/main
  2. ודא שיש commit חדש מהדקות האחרונות
  3. פתח Railway → successful-energy → Deployments
  4. ב-Build logs חפש: "Using Node v22"
