FROM node:24.22.3-alpine3.24
# Only rig/chaos.ts uses the Docker CLI; the relay image never has it.
RUN apk add --no-cache docker-cli
WORKDIR /app
# package.json only for "type": "module"; the rig has no npm dependencies.
COPY package.json ./
COPY rig ./rig
