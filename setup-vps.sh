#!/bin/bash
# ============================================================
#  RCE WebRTC Module — VPS Setup Script
#  Run this once on a fresh VPS to install everything.
# ============================================================

set -e

echo "=== RCE WebRTC — VPS Setup ==="

# 1. Update system
apt-get update -y && apt-get upgrade -y

# 2. Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Install coturn (TURN/STUN server)
apt-get install -y coturn

# 4. Install PM2 (process manager)
npm install -g pm2

# 5. Configure coturn
PUBLIC_IP="69.169.108.224"
TURN_SECRET="rce-webrtc-shared-secret"

cat > /etc/turnserver.conf << EOF
# RCE WebRTC — coturn configuration
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=${PUBLIC_IP}
external-ip=${PUBLIC_IP}

# Use shared secret for time-limited credentials
use-auth-secret
static-auth-secret=${TURN_SECRET}

# Realm (any domain works)
realm=re-circuit.com

# Performance
total-quota=100
stale-nonce=600
no-multicast-peers

# Logging
log-file=/var/log/turnserver.log
simple-log

# Allow both UDP and TCP relay
no-tcp-relay=false
EOF

# 6. Enable and start coturn
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn
systemctl restart coturn

# 7. Clone the repo
cd /opt
if [ -d "rce-webrtc" ]; then
  cd rce-webrtc && git pull
else
  git clone https://github.com/btournoy/rce-webrtc.git
  cd rce-webrtc
fi

# 8. Install dependencies
npm install

# 9. Create .env file
cat > .env << EOF
PORT=3000
PUBLIC_IP=${PUBLIC_IP}
TURN_PORT=3478
TURN_SECRET=${TURN_SECRET}
EOF

# 10. Start with PM2
pm2 delete rce-webrtc 2>/dev/null || true
pm2 start server.js --name rce-webrtc --env-path .env -- 
pm2 save
pm2 startup

# 11. Open firewall ports
ufw allow 3000/tcp    # Web server
ufw allow 3478/tcp    # TURN TCP
ufw allow 3478/udp    # TURN UDP
ufw allow 5349/tcp    # TURN TLS
ufw allow 49152:65535/udp  # TURN relay ports
echo "y" | ufw enable 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo "Web:  http://${PUBLIC_IP}:3000"
echo "TURN: turn:${PUBLIC_IP}:3478"
echo ""
echo "To update after code changes:"
echo "  cd /opt/rce-webrtc && git pull && npm install && pm2 restart rce-webrtc"
