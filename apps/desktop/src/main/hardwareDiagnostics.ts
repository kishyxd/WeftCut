import { app, utilityProcess, type UtilityProcess } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectLinuxHardware } from './linuxHardware';
import { createHardwareDiagnosticsService } from './hardwareDiagnosticsService';
import { reserveResources } from './resources';
import type { HardwareAccelerationDiagnostics, HardwareFailure } from '../shared/hardware-diagnostics';

const failure = (reason: HardwareFailure) => Object.assign(new Error(reason), { hardwareReason: reason });

export function createLinuxHardwareDiagnostics(ffmpeg: string) {
  let running: UtilityProcess | undefined;
  let stopRunning: (() => void) | undefined;
  let closed = false;
  const service = createHardwareDiagnosticsService({
    async inventory() {
      // GPU identity failure does not erase sysfs/NVML facts; retry after expiry.
      const info = await app.getGPUInfo('complete').catch(() => null);
      return collectLinuxHardware(info);
    },
    chromium() {
      const status = app.getGPUFeatureStatus();
      return { compositing: status.gpu_compositing ?? 'unknown', rasterization: status.rasterization ?? 'unknown',
        video_decode: status.video_decode ?? 'unknown', video_encode: status.video_encode ?? 'unknown' };
    },
    async probe(devices, publish) {
      let release: () => void;
      try { release = reserveResources(1, 192); } catch { throw failure('resource-busy'); }
      let directory: string | undefined;
      try {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weftcut-hardware-probe-'));
        if (closed) throw failure('probe-failed');
        const result = await new Promise<HardwareAccelerationDiagnostics>((resolve, reject) => {
          const child = utilityProcess.fork(path.join(import.meta.dirname, 'hardwareProbe.js'), [], {
            stdio: 'ignore', serviceName: 'KXVN Cut hardware diagnostics',
          });
          running = child;
          let grouped = false;
          let pid: number | undefined;
          const stop = () => {
            if (grouped && pid) { try { process.kill(-pid, 'SIGKILL'); } catch { child.kill(); } }
            else child.kill();
          };
          stopRunning = stop;
          let result: HardwareAccelerationDiagnostics | undefined;
          let error: Error | undefined;
          const timer = setTimeout(() => { error = failure('timeout'); stop(); }, 90_000);
          child.on('message', (message: { type: string; result?: HardwareAccelerationDiagnostics; grouped?: boolean; reason?: HardwareFailure }) => {
            if (message.type === 'ready') { pid = child.pid; grouped = message.grouped === true; child.postMessage({ directory, ffmpeg, devices }); }
            if (message.type === 'progress' && message.result) publish(message.result);
            if (message.type === 'complete') { result = message.result; child.postMessage({ type: 'ack' }); }
            if (message.type === 'failed') { error = failure(message.reason ?? 'probe-failed'); child.postMessage({ type: 'ack' }); }
          });
          child.on('error', () => { error = failure('probe-failed'); stop(); });
          child.once('exit', code => {
            clearTimeout(timer); running = undefined; stopRunning = undefined;
            // A crashing host may leave FFmpeg children behind. End the group
            // before releasing its reservation even on unexpected exits.
            if (grouped && pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already drained. */ } }
            // Reap the process before releasing admission, including timeout/crash.
            if (error || code !== 0 || !result) reject(error ?? failure('probe-failed'));
            else resolve(result);
          });
        });
        return result;
      } finally {
        try { if (directory) await fs.rm(directory, { recursive: true, force: true }); } finally { release(); }
      }
    },
    stop() { closed = true; if (stopRunning) stopRunning(); else running?.kill(); },
  });
  app.on('gpu-info-update', () => service.invalidate());
  app.once('before-quit', () => service.stop());
  return service;
}
