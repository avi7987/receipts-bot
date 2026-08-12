# ============================================================
#  Dockerfile — בוט הקבלות, לאירוח בענן (Railway)
#  כולל Chromium שדרוש ל-whatsapp-web.js
#
#  שים לב: הבוט שומר את החיבור לוואטסאפ בתיקייה. בענן חייבים
#  לחבר אליה דיסק קבוע (Volume), אחרת כל דיפלוי מנתק את הוואטסאפ
#  ודורש סריקת QR מחדש.
# ============================================================
FROM node:22-slim

# Chromium + פונטים (כולל עברית) + תעודות
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# puppeteer לא יוריד Chromium משלו — נשתמש במותקן במערכת
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src

# עמוד הבריאות מאזין על PORT שהענן מקצה
EXPOSE 3100
CMD ["node", "src/index.js"]
