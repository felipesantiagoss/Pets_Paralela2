const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '123456',
  database: process.env.PG_DATABASE || 'petz',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
});

module.exports = pool;
