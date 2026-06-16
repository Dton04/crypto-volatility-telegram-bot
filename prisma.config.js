// This file is used by Prisma CLI 7 to load the database connection configuration.
// It is written in JavaScript so it can run in production without ts-node.
require("dotenv/config");
const { defineConfig } = require("prisma/config");

// Build a dynamic fallback URL for local development/migrations
const dbUser = process.env.DB_USER || "telecrypt";
const dbPass = process.env.DB_PASSWORD || "telecrypt_secure_pass_135";
const dbHost = process.env.DB_HOST || "localhost";
const dbPort = process.env.DB_PORT || "5432";
const dbName = process.env.DB_NAME || "telecrypt_db";
const fallbackUrl = `postgresql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}?schema=public`;

module.exports = defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL || fallbackUrl,
  },
});
