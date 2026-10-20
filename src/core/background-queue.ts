import { logger } from '../utils/logger.js';

export type ConsistencyPolicy = 'strong' | 'eventual';

export interface BackgroundJob {
  id: string;
  type: string;
  run: () => Promise<void> | void;
  createdAt: number;
}

export class BackgroundQueue {
  private queue: BackgroundJob[] = [];
  private activeCount = 0;
  private readonly concurrency = 2;
  private isProcessing = false;

  enqueue(type: string, run: () => Promise<void> | void): string {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: BackgroundJob = { id, type, run, createdAt: Date.now() };
    this.queue.push(job);
    this.processNext();
    return id;
  }

  get pendingCount(): number {
    return this.queue.length + this.activeCount;
  }

  private processNext(): void {
    if (this.isProcessing || this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift();
    if (!job) return;

    this.activeCount++;
    Promise.resolve()
      .then(async () => {
        try {
          await job.run();
        } catch (err) {
          logger.error(`Background job ${job.id} (${job.type}) failed: ${(err as Error).message}`, {
            jobId: job.id,
            jobType: job.type,
          });
        } finally {
          this.activeCount--;
          this.processNext();
        }
      });
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.activeCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export const globalBackgroundQueue = new BackgroundQueue();
