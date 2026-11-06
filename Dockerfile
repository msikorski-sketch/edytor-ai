FROM node:24-slim

# git: historia zmian i cofanie; tar: rozpakowanie wydania z `git archive`; bsdtar (libarchive-tools): import ZIP;
# chromium + fonty: zrzuty ekranu, którymi agent sprawdza efekt zmian; ca-certificates: HTTPS do API.
RUN apt-get update && apt-get install -y --no-install-recommends git tar libarchive-tools ca-certificates \
    chromium fonts-dejavu-core fonts-liberation fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY serwer.mjs agent.mjs projekty.mjs zrzuty.mjs siec.mjs importer.mjs formularze.mjs zadania.mjs domeny.mjs konta.mjs integracje.mjs ./
COPY publiczne ./publiczne
COPY szablony ./szablony

# Agent działa jako zwykły użytkownik (uid 1000), nie root.
USER node
ENV HOME=/home/node EDYTOR_CHROMIUM=/usr/bin/chromium \
    GIT_AUTHOR_NAME="Edytor AI" GIT_AUTHOR_EMAIL=edytor@localhost \
    GIT_COMMITTER_NAME="Edytor AI" GIT_COMMITTER_EMAIL=edytor@localhost
EXPOSE 8080 8081 8082
CMD ["node", "serwer.mjs"]
