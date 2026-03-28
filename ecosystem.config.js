module.exports = {
  apps: [
    {
      name: 'herd',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3070,
        GO2RTC_URL: 'http://10.10.10.238:1984',
        HAILO_MODE: 'auto',
        DB_PATH: './data/herd.db'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3070,
        GO2RTC_URL: 'http://localhost:1984',
        HAILO_MODE: 'mock',
        DB_PATH: './data/herd.db'
      }
    }
  ]
};
