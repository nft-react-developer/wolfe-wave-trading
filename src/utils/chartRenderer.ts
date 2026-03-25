import { spawn } from 'child_process';
import path from 'path';
import type { WolfeWave, Candle } from '../types';
import { logger } from './logger';

// Path to the Python renderer script — bundled next to the compiled output.
// During development (tsx), __dirname points to src/utils/.
// In production (dist/), the script should be copied there too.
const RENDERER_SCRIPT = path.resolve(__dirname, 'wolfe_chart.py');

export interface ChartInput {
  wave:    WolfeWave;
  candles: Candle[];  // full candle array (renderer takes last 100)
}

/**
 * Generates a Wolfe Wave chart PNG using the Python renderer.
 * Returns the PNG as a Buffer, or null if rendering fails (so the
 * trade notification still goes out as text even if the chart errors).
 */
export async function generateWaveChart(input: ChartInput): Promise<Buffer | null> {
  const { wave, candles } = input;

  // Build the JSON payload expected by wolfe_chart.py
  const payload = {
    candles: candles.map(c => ({
      timestamp: c.timestamp,
      open:      c.open,
      high:      c.high,
      low:       c.low,
      close:     c.close,
    })),
    wave: {
      direction: wave.direction,
      p1: { index: wave.p1.index, price: wave.p1.price },
      p2: { index: wave.p2.index, price: wave.p2.price },
      p3: { index: wave.p3.index, price: wave.p3.price },
      p4: { index: wave.p4.index, price: wave.p4.price },
      p5: { index: wave.p5.index, price: wave.p5.price },
    },
    levels: {
      entryPrice:  wave.entryPrice,
      stopLoss:    wave.stopLoss,
      target1:     wave.target1,
      target2:     wave.target2,
      line14Price: wave.line14Price ?? null,
    },
    meta: {
      symbol:    wave.symbol,
      timeframe: wave.timeframe,
      shape:     wave.shape,
      direction: wave.direction,
    },
  };

  return new Promise((resolve) => {
    const py = spawn('python3', [RENDERER_SCRIPT], {
      // Increase buffer: 1280×720 PNG can be ~100-200 KB
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    py.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    py.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    py.on('error', (err) => {
      logger.error('chartRenderer: failed to spawn python3', err);
      resolve(null);
    });

    py.on('close', (code) => {
      if (code !== 0) {
        const errMsg = Buffer.concat(errChunks).toString('utf8');
        logger.error('chartRenderer: python renderer exited with code', { code, stderr: errMsg });
        resolve(null);
        return;
      }
      const png = Buffer.concat(chunks);
      if (png.length < 100) {
        logger.warn('chartRenderer: output too small, likely error', { bytes: png.length });
        resolve(null);
        return;
      }
      logger.debug('chartRenderer: PNG generated', { bytes: png.length, symbol: wave.symbol });
      resolve(png);
    });

    // Send payload to python stdin
    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}