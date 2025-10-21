import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { AiBrief, isAiBrief } from './types.js';
import { startJobWorker, triggerJobWorker } from './job-worker.js';

const PORT = Number(process.env.PORT ?? process.env.AIB_PORT ?? 8000);
const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.AIB_DATABASE_URL ??
  'postgresql://aibuser:psql789@127.0.0.1/aibuilder';
const SHARED_SECRET = process.env.AIB_SHARED_SECRET ?? 'replace_me_with_a_strong_token';

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Disable SSL by default; configure via env when deploying.
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
});

const app = express();
startJobWorker(pool);
triggerJobWorker();

app.use(express.json({ limit: '1mb' }));

// Simple request logger to help with debugging.
app.use((req: Request, res: Response, next: NextFunction) => {
  res.on('finish', () => {
    const line = `${req.method} ${req.originalUrl} -> ${res.statusCode}`;
    if (res.statusCode >= 500) {
      console.error(line);
    } else if (res.statusCode >= 400) {
      console.warn(line);
    } else {
      console.log(line);
    }
  });
  next();
});

type BuildSuccessResponse = { ok: true; request_id: number; status: 'queued' };
type BuildErrorResponse = { ok: false; error: string };
type BuildResponseBody = BuildSuccessResponse | BuildErrorResponse;

type ResultSuccessResponse = {
  ok: true;
  status: string;
  result_html: string | null;
  error_message: string | null;
};
type ResultErrorResponse = { ok: false; error: string };
type ResultResponseBody = ResultSuccessResponse | ResultErrorResponse;

interface JobRow {
  status: string;
  result_html: string | null;
  error_message: string | null;
}

function isAuthorized(headerValue: string | undefined): boolean {
  if (!SHARED_SECRET) return true;
  if (!headerValue) return false;
  return headerValue.trim() === `Bearer ${SHARED_SECRET}`;
}

app.post<Record<string, never>, BuildResponseBody, unknown>(
  '/build',
  async (req: Request<Record<string, never>, BuildResponseBody, unknown>, res: Response<BuildResponseBody>) => {
    if (!isAuthorized(req.header('authorization'))) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const payload = req.body;
    if (!isAiBrief(payload)) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
    }

    try {
      const result = await pool.query<{ id: number | string }>(
        `
          INSERT INTO aib_jobs (payload, status)
          VALUES ($1::jsonb, 'pending')
          RETURNING id
        `,
        [JSON.stringify(payload)],
      );

      const rawId = result.rows[0]?.id;
      const jobId =
        typeof rawId === 'string' ? Number.parseInt(rawId, 10) : typeof rawId === 'number' ? rawId : undefined;
      if (!jobId || Number.isNaN(jobId)) {
        return res.status(500).json({ ok: false, error: 'Failed to enqueue job' });
      }

      triggerJobWorker();
      return res.json({ ok: true, request_id: jobId, status: 'queued' });
    } catch (error) {
      console.error('Failed to insert job:', error);
      return res.status(500).json({ ok: false, error: 'Database error' });
    }
  },
);

app.get<{ jobId: string }, ResultResponseBody>(
  '/result/:jobId',
  async (req: Request<{ jobId: string }, ResultResponseBody>, res: Response<ResultResponseBody>) => {
    const jobId = Number(req.params.jobId);
    if (!Number.isInteger(jobId)) {
      return res.status(400).json({ ok: false, error: 'Invalid job id' });
    }

    try {
      const result = await pool.query<JobRow>(
        `
          SELECT status, result_html, error_message
          FROM aib_jobs
          WHERE id = $1
        `,
        [jobId],
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'Job not found' });
      }

      const row = result.rows[0];

      return res.json({
        ok: true,
        status: row.status,
        result_html: row.result_html,
        error_message: row.error_message,
      });
    } catch (error) {
      console.error('Failed to fetch job:', error);
      return res.status(500).json({ ok: false, error: 'Database error' });
    }
  },
);

const server = app.listen(PORT, () => {
  console.log(`AI Builder TS backend running on port ${PORT}`);
});

const shutdownSignals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
shutdownSignals.forEach((signal) => {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      void pool.end();
      console.log('Shutdown complete');
      process.exit(0);
    });
  });
});
