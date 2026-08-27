# Excalidraw Self-Hosted with AWS S3 Database & Realtime Collaboration

Comprehensive architecture, database design, backend, frontend, and production deployment documentation for self-hosting Excalidraw under `excalidraw.blueskyonline.org`.

---

## 🏛️ System Architecture Overview

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                   Client Browser                        │
                          │      https://excalidraw.blueskyonline.org               │
                          └──────────┬─────────────────────────────────┬────────────┘
                                     │ HTTPS (Port 443)                │ WSS (WebSockets)
                                     ▼                                 ▼
                          ┌─────────────────────────────────────────────────────────┐
                          │                   Nginx Reverse Proxy                   │
                          │          (Let's Encrypt SSL / Certbot)                  │
                          └──────────┬─────────────────────────────────┬────────────┘
                                     │                                 │
           ┌─────────────────────────┴───────────────┐                 │
           │ Static SPA Assets                       │ /api/* & /health│ /socket.io/*
           ▼                                         ▼                 ▼
┌───────────────────────┐                 ┌─────────────────────────────────────────┐
│   /var/www/excalidraw │                 │      Node.js Backend (Port 5000)        │
│   (Vite Production)   │                 │     - Express REST API                  │
└───────────────────────┘                 │     - Socket.io Multiplayer Engine      │
                                          └────────────────────┬────────────────────┘
                                                               │ AWS SDK v3
                                                               ▼
                                                  ┌─────────────────────────┐
                                                  │      AWS S3 Bucket      │
                                                  │ bluesky-excalidraw-     │
                                                  │ storage (ap-south-1)    │
                                                  └─────────────────────────┘
```

---

## 🗄️ 1. Database & Storage Architecture (AWS S3)

Rather than relying on third-party SaaS cloud storage or local volatile browser storage, all board scenes, metadata, and binary file attachments are stored in an **AWS S3 bucket**:

- **Bucket Name**: `bluesky-excalidraw-storage`
- **AWS Region**: `ap-south-1` (Mumbai)
- **Object Schema**:
  - `scenes/{id}.json`: Contains the full drawing state (`elements`, `appState`, `version`, `name`).
    - **S3 User Metadata**: `x-amz-meta-boardname` stores the URL-encoded human-readable name of the board for fast index-free listing.
  - `files/{id}`: Contains uploaded images, pasted drawings, and binary media with immutable 1-year caching headers.

### Fallback Mode
If AWS S3 credentials are omitted or invalid, the backend automatically switches to `LOCAL_FALLBACK` mode and stores drawings in `./server/local-storage/` without crashing.

---

## ⚙️ 2. Backend Architecture (`server/`)

The backend is a Node.js 20 microservice running in a Docker container on port `5000`:

- **Framework**: Express.js + HTTP Server + Socket.io Server.
- **REST Endpoints**:
  - `GET /health`: Returns JSON with storage connectivity mode (`AWS_S3`), bucket, region, and collaboration status.
  - `GET /api/v1/scenes`: Lists all saved boards with their clean titles, last modified timestamps, and file sizes.
  - `POST /api/v1/scenes/:id`: Saves or updates a scene in S3 with board name metadata.
  - `GET /api/v1/scenes/:id`: Fetches a scene by ID for loading into the canvas.
  - `DELETE /api/v1/scenes/:id`: Deletes a scene from S3.
  - `POST /api/v1/files/:id` & `GET /api/v1/files/:id`: Binary uploads and downloads.
- **Realtime Collaboration Engine (Socket.io)**:
  - `join-room` / `init-room`: Room initialization with room key encryption.
  - `room-user-change`: Broadcasts active collaborator socket IDs and updates collaborator avatars in the UI.
  - `server-broadcast`: Broadcasts encrypted drawing strokes in real-time.
  - `server-volatile-broadcast`: Broadcasts real-time mouse cursor coordinates, idle states, and viewports.

---

## 🎨 3. Frontend Architecture (`excalidraw-app/`)

The frontend is a customized Vite + React Single Page Application (SPA):

- **Cloud Boards Workspace Dialog (`S3BoardsDialog.tsx` & `.scss`)**:
  - Accessible via the main menu: **☰ &rarr; Cloud Boards (AWS S3)**.
  - **Live S3 Status Badge**: Shows whether S3 storage is connected.
  - **Save Drawing with Title**: Allows naming boards with clean human titles.
  - **Browse & Search**: Filter saved boards by name, view last modified date, and board size.
  - **Direct Loading & Deletion**: 1-click loading and deletion directly with S3.
- **URL Routing**:
  - `https://excalidraw.blueskyonline.org/?board=<board_id>` automatically loads the saved S3 board.
  - `https://excalidraw.blueskyonline.org/#room=<room_id>,<key>` connects to end-to-end encrypted live collaboration rooms.
- **API Client (`s3Storage.ts`)**:
  - Abstracts all communication with `/api/v1/*` and `/health`.

---

## 🚀 4. Ubuntu Server & Production Deployment

### Server Specifications:
- **Host**: AWS Lightsail Ubuntu (`34.200.211.37`)
- **Domain**: `excalidraw.blueskyonline.org` (Route 53 A-Record &rarr; `34.200.211.37`)
- **Port Allocation**:
  - `80` / `443`: Nginx (Serving frontend & SSL reverse proxy)
  - `3000`: Gitea (Existing service - preserved)
  - `4000`: Realestate-agent (Existing service - preserved)
  - `5000`: `excalidraw-s3-backend` (Docker container)

### Nginx Virtual Host Configuration:
File location: `/etc/nginx/sites-available/excalidraw.blueskyonline.org`

```nginx
server {
    server_name excalidraw.blueskyonline.org;

    root /var/www/excalidraw;
    index index.html;

    # SPA Client Routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # S3 Backend API
    location /api/ {
        proxy_pass http://127.0.0.1:5000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100M;
    }

    # Real-Time WebSocket Collaboration
    location /socket.io/ {
        proxy_pass http://127.0.0.1:5000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Healthcheck Endpoint
    location /health {
        proxy_pass http://127.0.0.1:5000/health;
    }

    # Asset Caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, no-transform";
    }

    listen 443 ssl; # Managed by Certbot
    ssl_certificate /etc/letsencrypt/live/excalidraw.blueskyonline.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/excalidraw.blueskyonline.org/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

# Automatic HTTP to HTTPS 301 Redirect
server {
    if ($host = excalidraw.blueskyonline.org) {
        return 301 https://$host$request_uri;
    }
    server_name excalidraw.blueskyonline.org;
    listen 80;
    return 404;
}
```

---

## 🔒 5. Environment Variables & Security

### `.env` & `server/.env` Reference:
```env
# AWS S3 Storage Settings
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_S3_BUCKET=bluesky-excalidraw-storage
PORT=5000
```

> **Security Note:**
> All `.env`, `*.pem`, `*.key`, and secret files are permanently ignored in `.gitignore`. Use `.env.example` as a template when setting up new environments.

---

## 🛠️ 6. Useful Maintenance Commands

### Check Backend Status & Logs:
```bash
# View backend logs
sudo docker logs -f excalidraw-s3-backend

# Restart backend container
sudo docker restart excalidraw-s3-backend
```

### Test Healthcheck:
```bash
curl https://excalidraw.blueskyonline.org/health
```

### Test SSL Certificate Renewal:
```bash
sudo certbot renew --dry-run
```

---

## 💻 7. Local Development Guide

1. Install dependencies:
   ```bash
   yarn install
   cd server && npm install && cd ..
   ```
2. Start the local backend:
   ```bash
   cd server
   node index.js
   ```
3. Start the Vite development frontend:
   ```bash
   yarn start
   ```
4. Open `http://localhost:3000` in your browser.
