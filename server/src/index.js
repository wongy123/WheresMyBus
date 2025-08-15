import 'dotenv/config';
import express from 'express';
import routeRouter from './routes/route.routes.js';
import stopRouter from './routes/stop.routes.js';
import { errorHandler, notFound } from './middleware/error.js';

const app = express();
app.use(express.json());

// Basic health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Routes
app.use('/route', routeRouter);
app.use('/stop', stopRouter);

// 404 + error handler
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WheresMyBusAPI listening on http://localhost:${PORT}`);
});
