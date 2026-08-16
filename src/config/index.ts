import dotenv from 'dotenv';
import path from 'path';
import { env } from 'process';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env'), quiet: true });

// Export config from environment
export default {
  port: env.PORT,
  database_url: env.DATABASE_URL,
  bcrypt_salt_rounds: env.BCRYPT_SALT_ROUNDS,
  jwt_access_secret: env.JWT_ACCESS_SECRET,
  jwt_refresh_secret: env.JWT_REFRESH_SECRET,
  jwt_access_expires_in: env.JWT_ACCESS_EXPIRES_IN,
  jwt_refresh_expires_in: env.JWT_REFRESH_EXPIRES_IN,
  app_url: env.APP_URL,
  env: env.NODE_ENV,
};
