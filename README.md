# Moroccan Taste POS/ERP System

## Quick Start with Docker

```bash
docker-compose up -d
```

Access: http://localhost:3000

## Manual Setup

1. Install MySQL 8.0
2. Create database: `mysql -u root -p < db/schema.sql`
3. Copy `.env.example` to `.env` and fill in your values
4. `npm install`
5. `npm start`

## Deploy to VPS

1. Buy VPS (Hetzner/Contabo)
2. SSH into server
3. Install Docker: `curl -fsSL https://get.docker.com | sh`
4. Clone project: `git clone ...`
5. `docker-compose up -d`
6. Setup domain + SSL with Nginx
