FROM node:24.22.3-alpine3.24
WORKDIR /app
# package.json only for "type": "module"; the rig has no npm dependencies.
COPY package.json ./
COPY rig ./rig
