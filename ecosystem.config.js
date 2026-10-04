// P0: process manager PM2 (npm i -g pm2 && pm2 start ecosystem.config.js && pm2 save)
// Ganti nohup/manual node dengan ini saat go-live.
module.exports = {
  apps: [
    {
      name: 'inventory-pos-api',
      script: 'dist/server.js',
      instances: 1, // 1 proses: rate limiter in-memory & pool terpusat
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '300M',
      autorestart: true,
    },
  ],
};
