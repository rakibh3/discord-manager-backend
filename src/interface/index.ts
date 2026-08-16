import { JwtPayload } from 'jsonwebtoken';

export type UserRole = 'ADMIN' | 'INSTRUCTOR' | 'STUDENT';

export interface TUser extends JwtPayload {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}
