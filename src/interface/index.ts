import { JwtPayload } from 'jsonwebtoken';

export type UserRole = 'ADMIN';

export interface TUser extends JwtPayload {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
