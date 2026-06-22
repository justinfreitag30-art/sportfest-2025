# Sportfest 2025

Live-Turnier-Webapp mit Echtzeit-Score-Updates via Socket.io.

## Lokal testen
1. npm install
2. node server.js
3. http://localhost:3000        ← Zuschauer
4. http://localhost:3000/admin  ← Admin

## Deploy auf Railway.app (kostenlos, öffentlich)
1. Gehe zu https://railway.app und melde dich mit GitHub an
2. Klicke "New Project" → "Deploy from GitHub repo"
3. Verbinde dieses Repository
4. Railway erkennt Node.js automatisch und deployed
5. Klicke auf "Settings" → "Generate Domain"
6. Du bekommst eine URL wie: https://sportfest-2025.up.railway.app
7. Diese URL mit allen teilen — fertig!

Hinweis: data.json wird auf Railway bei jedem Redeploy zurückgesetzt.
Scores während des Sportfests können durch den Admin jederzeit neu gesetzt werden.
