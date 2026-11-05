FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production
ENV SDF_HEADED=1
CMD ["xvfb-run", "-a", "node", "src/server.js"]

