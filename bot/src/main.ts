import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { SlackService } from './slack/slack.service';
import { BOT_NAME } from './slack/slack.constants';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const expressApp = app.getHttpAdapter().getInstance();

  const slackService = app.get(SlackService);
  expressApp.use((req, _res, next) => {
    if (req.path.startsWith('/slack')) {
      const eventType = (req.body as { event?: { type?: string } })?.event?.type;
      console.log(`[Slack] ${req.method} ${req.path}${eventType ? ` (${eventType})` : ''}`);
    }
    next();
  });
  expressApp.use(slackService.receiver.router);
  expressApp.use(json());
  expressApp.use(urlencoded({ extended: true }));

  app.enableCors({
    origin: process.env.ADMIN_ORIGIN ?? 'http://localhost:3001',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`${BOT_NAME} running on port ${port}`);
}

bootstrap();
