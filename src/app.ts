import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Application } from 'express';

import errorHandler from '@/errors/globalErrorHandler';
import { notFoundRoute } from '@/errors/notFound';
import { authRouter } from '@/modules/auth/auth.routes';
import { userRouter } from '@/modules/user/user.routes';

const app: Application = express();

app.use(
  cors({
    origin: process.env.APP_URL,
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.use(notFoundRoute);
app.use(errorHandler);

export default app;
