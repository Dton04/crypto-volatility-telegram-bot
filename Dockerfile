# Stage 1: Build dependencies & generate Prisma client
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies) to compile TypeScript
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy application source code
COPY . .

# Build target application
ARG APP_NAME
RUN npx nest build ${APP_NAME}

# Prune devDependencies to keep final image footprint small
RUN npm prune --omit=dev

# Stage 2: Production runner image
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

ARG APP_NAME
ENV APP_NAME=${APP_NAME}
ENV NODE_ENV=production

# Copy package info and production node_modules from builder
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy build artifacts and prisma settings
COPY --from=builder /usr/src/app/dist/apps/${APP_NAME} ./dist
COPY --from=builder /usr/src/app/prisma ./prisma
COPY --from=builder /usr/src/app/prisma.config.js ./

# Entrypoint runner command
CMD ["node", "dist/main.js"]
