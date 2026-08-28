#!/bin/bash
# ==============================================================================
# Excalidraw S3 Deployment Script for AWS Lightsail Ubuntu (excalidraw.blueskyonline.org)
# ==============================================================================
set -e

DOMAIN="excalidraw.blueskyonline.org"
BACKEND_PORT=5000
FRONTEND_PORT=3002

echo "🚀 Starting deployment for $DOMAIN..."

# 1. Update and install prerequisites
sudo apt update
sudo apt install -y docker.io docker-compose nginx certbot python3-certbot-nginx
sudo systemctl enable --now docker

# 2. Start Containers
if [ -f "docker-compose.prod.yml" ]; then
    echo "📦 Starting Docker containers..."
    sudo docker-compose -f docker-compose.prod.yml up -d --build
fi

# 3. Configure Nginx Reverse Proxy
echo "🌐 Configuring Nginx reverse proxy..."
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"

sudo bash -c "cat > $NGINX_CONF" << EOF
server {
    server_name $DOMAIN;

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:$FRONTEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    # S3 Backend API
    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 100M;
    }

    # Real-time WebSocket Collaboration
    location /socket.io/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Health Check
    location /health {
        proxy_pass http://127.0.0.1:$BACKEND_PORT/health;
    }
}
EOF

sudo ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$DOMAIN"
sudo nginx -t
sudo systemctl reload nginx

# 4. Request Let's Encrypt SSL
echo "🔒 Requesting SSL Certificate for $DOMAIN..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || true

echo "✅ Deployment complete! Access your app at https://$DOMAIN"
