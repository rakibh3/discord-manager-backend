import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Application } from 'express';

import config from '@/config';
import errorHandler from '@/errors/globalErrorHandler';
import { notFoundRoute } from '@/errors/notFound';
import { announcementRouter } from '@/modules/announcement/announcement.routes';
import { attendanceRouter } from '@/modules/attendance/attendance.routes';
import { authRouter } from '@/modules/auth/auth.routes';
import { dailyStatusRouter } from '@/modules/dailyStatus/dailyStatus.routes';
import { discordRouter } from '@/modules/discord/discord.routes';
import { reminderRouter } from '@/modules/reminder/reminder.routes';
import { rosterRouter } from '@/modules/roster/roster.routes';
import { scheduleRouter } from '@/modules/schedule/schedule.routes';
import { userRouter } from '@/modules/user/user.routes';

const app: Application = express();

// Client IP resolution, which the public rate limiters count against.
// Set as an integer hop count or not at all — never `true`, which would let a
// caller forge `X-Forwarded-For` and evade every budget. See config/index.ts.
if (config.trust_proxy_hops !== undefined) {
  app.set('trust proxy', config.trust_proxy_hops);
}

app.use(
  cors({
    // Explicit allowlist: the admin dashboard and the public attendance form
    // are separate deployments. Never `'*'` or `true` alongside credentials.
    origin: config.allowed_origins,
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/discord', discordRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/daily-status', dailyStatusRouter);
app.use('/api/reminders', reminderRouter);
app.use('/api/announcement', announcementRouter);
// The enrolment roster and the switch that arms the email check. Admin-only —
// it holds contact details for every enrolled student. See roster.routes.ts.
app.use('/api/roster', rosterRouter);
// The only unauthenticated router in the application — students have no
// account to authenticate with. See attendance.routes.ts.
app.use('/api/attendance', attendanceRouter);

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.use(notFoundRoute);
app.use(errorHandler);

export default app;
