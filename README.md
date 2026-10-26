# 🌉 AirBridge (iOS ⇄ Android Direct P2P File Sharing)

> **Zero Cloud Storage • 5–10 GB Large File Support • WebRTC Peer-to-Peer • Free GitHub Pages Deployment**

AirBridge solves cross-platform file sharing between **iOS (Safari)** and **Android (Chrome)** without sending or storing files on third-party servers. 

---

## 🚀 Key Features

- **Direct P2P via WebRTC**: Files transfer directly over Wi-Fi / Local Network at maximum speed.
- **5–10 GB Chunk Streaming**: Uses 64 KB memory chunks with backpressure management to prevent iOS Safari & mobile browsers from running out of RAM.
- **Zero-Storage Privacy**: No files are uploaded or stored anywhere. The signaling server only exchanges pairing tokens.
- **Screen Wake Lock**: Automatically prevents mobile screens from sleeping during multi-gigabyte transfers.
- **Instant Pairing**: 4-digit PIN code + dynamic QR code for instant camera scan pairing.
- **GitHub Actions Ready**: Pre-configured CI/CD workflow to auto-build and publish to GitHub Pages upon pushing to `main`.

---

## 📁 Monorepo Structure

```
airbridge/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions auto-deploy to GitHub Pages
├── client/                     # FRONTEND (Vite + TypeScript)
│   ├── index.html              # Responsive mobile-first UI
│   ├── src/
│   │   ├── main.ts             # WebRTC chunk stream & pairing logic
│   │   └── style.css           # Glassmorphism dark aesthetic
│   ├── vite.config.ts
│   └── package.json
├── server/                     # BACKEND (Node.js + WebSocket Signaling)
│   ├── src/
│   │   └── index.ts            # Lightweight room-based signaling
│   └── package.json
└── package.json                # Monorepo scripts (run both with 1 command)
```

---

## 🛠️ Quick Start (Local Development)

### 1. Install dependencies
```bash
npm run install:all
```

### 2. Start both Frontend & Backend concurrently
```bash
npm run dev
```

- **Frontend**: `http://localhost:3000` (also broadcast on your local network IP like `http://192.168.x.x:3000` so you can open it on your real iPhone / Android device!)
- **Backend (Signaling)**: `ws://localhost:9000`

---

## 🚢 Deploying to GitHub Pages

1. Push this repository to your GitHub account:
   ```bash
   git init
   git add .
   git commit -m "Initial commit of AirBridge"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/airbridge.git
   git push -u origin main
   ```
2. In your GitHub repository:
   - Go to **Settings** $\rightarrow$ **Pages**
   - Under **Build and deployment** > **Source**, select **GitHub Actions**.
3. Every push to `main` will automatically build the client and deploy it live!
