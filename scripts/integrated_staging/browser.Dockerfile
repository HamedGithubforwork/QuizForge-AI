FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY e2e/package.json e2e/package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/integrated_staging/browser.mjs ./
ENV HOME=/tmp PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER 10001:10001
CMD ["node", "browser.mjs"]
