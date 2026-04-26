import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {

  const app = await NestFactory.create(AppModule);
  
  const clientOrigin = process.env.CLIENT_ORIGIN;
  if (!clientOrigin) {
    throw new Error('CLIENT_ORIGIN environment variable is required. Set it to your client URL(s).');
  }
  
  app.enableCors({
    origin: clientOrigin.split(',').map(o => o.trim()),
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  await app.listen(process.env.PORT ?? 5001);
}

void bootstrap();
