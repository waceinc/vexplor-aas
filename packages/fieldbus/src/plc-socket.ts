/**
 * One TCP connection that exchanges whole frames, one request at a time — shared by the S7 and MC clients.
 *
 * Important: one request in flight. The MC 3E frame carries no request id at all, and S7 PLCs answer in order with a
 *    small "AmQ" (parallel jobs, often 1), so a queue is the honest model of both.
 * Important: a timeout **destroys** the connection. A late answer would otherwise be taken as the answer to the next
 *    request (3E cannot tell them apart) — a wrong value is worse than a missing one. The reader then reconnects on
 *    its next read, the same way the Modbus reader drops a failed connection.
 */
import { Socket } from 'node:net';
import { fill, tr } from '@aas/core';

/** How long the frame starting at buffer[0] is, or undefined while its length is not known yet */
export type FrameLength = (buffer: Buffer) => number | undefined;

interface Waiting {
  resolve: (frame: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class FrameSocket {
  private buffer: Buffer = Buffer.alloc(0);
  private waiting: Waiting | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private dead: Error | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly frameLength: FrameLength,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error(tr('연결이 끊겼습니다.'))));
  }

  /** `label` names the device kind in the timeout message (S7 · MC) */
  static connect(host: string, port: number, frameLength: FrameLength, timeoutMs: number, label: string): Promise<FrameSocket> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(fill(tr('{0} 장치에 붙지 못했습니다(시간 초과): {1}:{2}'), { 0: label, 1: host, 2: port })));
      }, timeoutMs);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect(port, host, () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new FrameSocket(socket, frameLength, timeoutMs));
      });
    });
  }

  /** False once the connection broke, timed out or was closed — the owner then connects again */
  get alive(): boolean {
    return this.dead === undefined;
  }

  /** Sends one frame and resolves with the next whole frame that arrives */
  exchange(frame: Buffer): Promise<Buffer> {
    const run = (): Promise<Buffer> =>
      new Promise<Buffer>((resolve, reject) => {
        if (this.dead) return reject(this.dead);
        const timer = setTimeout(() => {
          this.waiting = undefined;
          const error = new Error('Timeout');
          reject(error);
          this.fail(error);
          this.socket.destroy();
        }, this.timeoutMs);
        this.waiting = { resolve, reject, timer };
        this.socket.write(frame);
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): Promise<void> {
    this.fail(new Error(tr('닫았습니다.')));
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.end(() => resolve());
      this.socket.destroy();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const length = this.frameLength(this.buffer);
      if (length !== undefined && length < 1) {
        // A frame that claims no length can never be consumed — stop instead of spinning on it
        this.fail(new Error(tr('장치가 형식이 깨진 응답을 보냈습니다.')));
        this.socket.destroy();
        return;
      }
      if (length === undefined || this.buffer.length < length) return;
      const frame = Buffer.from(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
      const waiting = this.waiting;
      this.waiting = undefined;
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      waiting.resolve(frame);
    }
  }

  private fail(error: Error): void {
    this.dead ??= error;
    const waiting = this.waiting;
    this.waiting = undefined;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }
}
