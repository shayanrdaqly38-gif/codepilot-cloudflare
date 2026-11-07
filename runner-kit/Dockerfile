# CodePilot 24/7 Cloud Linux Sandbox (Hugging Face Spaces / Render / Fly.io / Docker)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces runs containers as non-root UID 1000
RUN useradd -m -u 1000 runner || true
USER 1000
WORKDIR /home/runner/app

ENV HOME=/home/runner \
    PORT=7860 \
    HOST=0.0.0.0 \
    CP_WORKDIR=/home/runner/codepilot-workspace

COPY --chown=1000:1000 server.mjs ./server.mjs
RUN mkdir -p /home/runner/codepilot-workspace

EXPOSE 7860
CMD ["node", "server.mjs"]
