FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY e2e/package.json e2e/package-lock.json ./
RUN npm ci
COPY preview-source/frontend ./frontend
RUN npm ci --prefix frontend
COPY scripts/cognito_browser/browser ./driver
COPY scripts/cognito_browser/browser/vite.config.mjs ./frontend/.rehearsal-vite.config.mjs
ENV HOME=/tmp
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
CMD ["node", "driver/live.mjs"]
