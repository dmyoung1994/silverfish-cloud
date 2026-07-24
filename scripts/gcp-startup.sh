#!/bin/bash
set -euo pipefail

image="us-west1-docker.pkg.dev/gen-lang-client-0308672059/co-dex/relay:latest"
registry="us-west1-docker.pkg.dev"
relay_hostname="2600-1900-4041-40e-0-1-0-0.sslip.io"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install --yes \
  ca-certificates \
  curl \
  docker.io \
  jq \
  nginx \
  python3-pip \
  python3-venv
systemctl enable --now docker

if [[ ! -x /opt/certbot/bin/certbot ]]; then
  python3 -m venv /opt/certbot
fi
/opt/certbot/bin/pip install --quiet --upgrade 'certbot>=5.4'

token="$(curl --fail --silent --show-error \
  --header 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | jq --raw-output .access_token)"
printf '%s' "$token" | docker login \
  --username oauth2accesstoken \
  --password-stdin \
  "https://${registry}"
unset token

proxy_secret="$(curl --fail --silent --show-error \
  --header 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/silverfish-relay-proxy-secret')"
if [[ -z "$proxy_secret" ]]; then
  echo 'Missing silverfish-relay-proxy-secret instance metadata' >&2
  exit 1
fi

docker pull "$image"
docker logout "$registry"
docker rm --force co-dex-relay 2>/dev/null || true
docker run --detach \
  --name co-dex-relay \
  --restart unless-stopped \
  --network host \
  --read-only \
  --tmpfs /tmp \
  --security-opt no-new-privileges=true \
  --env 'CO_DEX_RELAY_ADDR=[::]:8787' \
  --env 'CO_DEX_WEB_DIR=/app/web' \
  --env 'SILVERFISH_MAX_GUESTS_PER_ROOM=1' \
  --env 'SILVERFISH_PAID_MAX_GUESTS_PER_ROOM=8' \
  --env 'SILVERFISH_PAID_ROOM_LIFETIME_SECONDS=0' \
  --env "SILVERFISH_RELAY_PROXY_SECRET=${proxy_secret}" \
  --env 'SILVERFISH_ROOM_LIFETIME_SECONDS=3600' \
  --env 'RUST_LOG=co_dex_relay=info,tower_http=info' \
  "$image"
unset proxy_secret

relay_ip="$(ip -6 -o address show dev ens4 scope global | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
if [[ -z "$relay_ip" ]]; then
  echo 'No global IPv6 address found on ens4' >&2
  exit 1
fi

resolved_relay_ip="$(getent ahostsv6 "$relay_hostname" | awk 'NR == 1 {print $1}')"
if [[ "$resolved_relay_ip" != "$relay_ip" ]]; then
  echo "${relay_hostname} resolved to ${resolved_relay_ip:-nothing}, expected ${relay_ip}" >&2
  exit 1
fi

certificate_dir="/etc/letsencrypt/live/${relay_hostname}"
if [[ ! -s "${certificate_dir}/fullchain.pem" || ! -s "${certificate_dir}/privkey.pem" ]]; then
  systemctl stop nginx
  /opt/certbot/bin/certbot certonly \
    --standalone \
    --domain "$relay_hostname" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email
fi

rm -f /etc/nginx/sites-enabled/default
cat > /etc/nginx/sites-available/co-dex <<NGINX
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen [::]:80;
    server_name ${relay_hostname};
    return 308 https://${relay_hostname}\$request_uri;
}

server {
    listen [::]:443 ssl;
    server_name ${relay_hostname};
    ssl_certificate ${certificate_dir}/fullchain.pem;
    ssl_certificate_key ${certificate_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://[::1]:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/co-dex /etc/nginx/sites-enabled/co-dex
nginx -t
systemctl enable --now nginx
systemctl reload nginx

cat > /etc/systemd/system/co-dex-cert-renew.service <<'SERVICE'
[Unit]
Description=Renew the Silverfish relay TLS certificate
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx"
SERVICE

cat > /etc/systemd/system/co-dex-cert-renew.timer <<'TIMER'
[Unit]
Description=Check the co-dex TLS certificate twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now co-dex-cert-renew.timer
