# CodePilot cloud runner — real Linux execution for the agent's run_command.
# Works on any Docker host: Hugging Face Spaces (PRO), Render, Fly, a VPS...
#
# The runner is a single zero-dependency Node server (>= 18). HF Spaces and
# most PaaS providers proxy external HTTPS traffic to container port 7860.
FROM node:20-slim

# Tools the agent uses most (bash ships with the base image).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 python3-pip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs ./

# Bind the port the platform proxies (HF Spaces expects 0.0.0.0:7860).
ENV CP_HOST=0.0.0.0 CP_PORT=7860
EXPOSE 7860

# Set CP_TOKEN as a secret/environment variable on the platform — never here.
CMD ["node", "server.mjs"]
