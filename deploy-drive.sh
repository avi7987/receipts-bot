#!/usr/bin/env bash
# ============================================================
#  deploy-drive.sh — פריסת שירות הדרייב לעמיתים.
#
#  הרצה בשרת:  bash ~/receipts-drive/deploy-drive.sh
#  (בפעם הראשונה: curl את הקובץ מגיטהאב, או העתק אותו לשרת)
#
#  לא נוגע בבוט הוואטסאפ: עותק קוד נפרד, מכולה נפרדת, נתונים
#  בתיקייה נפרדת, והגדרות משלו. update.sh של הבוט לא נוגע בשירות
#  הזה, והסקריפט הזה לא נוגע בבוט.
# ============================================================
set -euo pipefail

REPO=https://github.com/avi7987/receipts-bot.git
APP=/home/ubuntu/receipts-drive
DATA=/home/ubuntu/receipts-drive-data
ENV_FILE=$APP/drive.env
BOT_ENV=/home/ubuntu/receipts-bot/.env
HOST=drive.84-13-85-127.sslip.io
CADDYFILE=/opt/caddy/Caddyfile

echo "=== קוד ==="
[ -d "$APP/.git" ] || git clone -q "$REPO" "$APP"
git -C "$APP" pull -q
git -C "$APP" log -1 --format='%h  %s'

echo ""
echo "=== הגדרות ==="
if [ ! -f "$ENV_FILE" ]; then
  # חשבון השירות משותף עם הבוט. מפתח ה-AI שלך — לא: נשמר רק הגיבוב
  # שלו, כדי שהשירות יוכל לזהות ולסרב לו, בלי שיוכל להשתמש בו.
  owner_key=$(grep -E '^GEMINI_API_KEY=' "$BOT_ENV" | head -1 | cut -d= -f2- \
    | sed -e 's/\r$//' -e 's/^["'\'']//' -e 's/["'\'']$//' | xargs)
  [ -n "$owner_key" ] || { echo "❌ לא נמצא GEMINI_API_KEY בהגדרות הבוט"; exit 1; }
  owner_hash=$(printf '%s' "$owner_key" | sha256sum | cut -d' ' -f1)
  unset owner_key

  umask 077
  {
    echo "# שירות הדרייב — נוצר $(date -Iseconds). בלי מפתח AI של הבעלים."
    grep -E '^GOOGLE_SERVICE_ACCOUNT_EMAIL=' "$BOT_ENV"
    grep -E '^GOOGLE_PRIVATE_KEY=' "$BOT_ENV"
    grep -E '^GEMINI_MODEL=' "$BOT_ENV" || true
    echo "OWNER_KEY_HASH=$owner_hash"
    echo "PUBLIC_BASE_URL=https://$HOST"
    echo "ALLOW_ORIGIN=https://bynetprod.service-now.com"
    echo "POLL_MINUTES=3"
  } > "$ENV_FILE"
  echo "נוצר $ENV_FILE"
else
  echo "קיים — לא נוגעים"
fi
grep -q '^GEMINI_API_KEY=' "$ENV_FILE" && { echo "❌ יש מפתח AI בהגדרות השירות — אסור"; exit 1; }

# קוד הצוות לדף ההרשמה. נוצר פעם אחת; להחלפה — מוחקים את השורה ומריצים שוב.
if ! grep -q '^JOIN_CODE=' "$ENV_FILE"; then
  # head קורא מ-urandom ישירות: בצינור הפוך (tr | head) ה-tr מקבל SIGPIPE,
  # ועם pipefail הסקריפט כולו היה נעצר כאן
  echo "JOIN_CODE=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"
  echo "נוצר קוד צוות חדש"
fi
JOIN_CODE=$(grep -E '^JOIN_CODE=' "$ENV_FILE" | cut -d= -f2-)

mkdir -p "$DATA"
sudo chmod 700 "$DATA"

echo ""
echo "=== בנייה ==="
sudo docker build -q -f "$APP/Dockerfile.drive" -t receipts-drive "$APP" >/dev/null
echo "✅"

echo ""
echo "=== הפעלה ==="
sudo docker rm -f receipts-drive >/dev/null 2>&1 || true
# בלי פורט פתוח לעולם: נגיש רק דרך Caddy ברשת הפנימית
sudo docker run -d \
  --name receipts-drive \
  --restart unless-stopped \
  --memory 384m --network receipts-net \
  -v "$ENV_FILE":/app/.env:ro \
  -v "$DATA":/app/data \
  receipts-drive >/dev/null
echo "✅"

echo ""
echo "=== כתובת ==="
if ! sudo grep -q "$HOST" "$CADDYFILE"; then
  backup="$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
  sudo cp "$CADDYFILE" "$backup"
  printf '\n%s {\n\treverse_proxy receipts-drive:3200\n}\n' "$HOST" | sudo tee -a "$CADDYFILE" >/dev/null
  # בדיקה לפני טעינה: קובץ שבור היה מפיל גם את הבוט שלך
  if sudo docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    echo "✅ נוסף $HOST (גיבוי: $backup)"
  else
    sudo cp "$backup" "$CADDYFILE"
    echo "❌ ההגדרה החדשה לא עברה בדיקה — שוחזר הקובץ הקודם"
    exit 1
  fi
else
  echo "קיימת — לא נוגעים"
fi

echo ""
echo "=== מצב ==="
sleep 8
sudo docker ps --filter name=receipts-drive --format 'מכולה: {{.Status}}'
sudo docker logs --tail 5 receipts-drive 2>&1
healthy=""
for i in 1 2 3 4 5 6; do
  if out=$(curl -fsS -m 10 "https://$HOST/" 2>/dev/null); then echo "בריאות: $out"; healthy=1; break; fi
  sleep 10
done
[ -n "$healthy" ] || echo "⚠️  https://$HOST עוד לא עונה (הנפקת תעודה יכולה לקחת דקה). בדוק שוב: curl https://$HOST/"

echo ""
echo "=== קישור ההרשמה לצוות ==="
echo "https://$HOST/join?code=$JOIN_CODE"
