#!/bin/bash
set -e

echo "1. Writing Nginx configuration..."
cat << 'EOF' > /etc/nginx/sites-available/excalidraw.blueskyonline.org
server {
    server_name excalidraw.blueskyonline.org;

    root /var/www/excalidraw;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100M;
    }

    # Real-time WebSocket Collaboration
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

    location /health {
        proxy_pass http://127.0.0.1:5000/health;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, no-transform";
    }
}
EOF

echo "2. Enabling Nginx site..."
ln -sf /etc/nginx/sites-available/excalidraw.blueskyonline.org /etc/nginx/sites-enabled/

echo "3. Testing Nginx configuration..."
nginx -t

echo "4. Reloading Nginx..."
systemctl reload nginx

echo "5. Requesting SSL Certificate..."
certbot --nginx -d excalidraw.blueskyonline.org --non-interactive --agree-tos --register-unsafely-without-email || true

echo "=== DEPLOYMENT COMPLETE ==="
