import cron from 'node-cron';
import { generateDailyReport } from '../services/statistics';
import { snapshotDailyVolumes, getTopSymbols } from '../services/symbolSelector';
import { telegram } from '../services/telegram';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export function startDailyReportScheduler() {
  const cronExpr = config.dailyReportCron;

  if (!cron.validate(cronExpr)) {
    logger.error(`Invalid cron expression: ${cronExpr}`);
    return;
  }

  cron.schedule(cronExpr, async () => {
    logger.info('Generating daily report...');
    try {
      const report = await generateDailyReport(config.tradingMode);
      await telegram.sendDailyReport(report);
      logger.info('Daily report sent', report);
    } catch (err) {
      logger.error('Daily report failed', err);
    }
  });

  logger.info(`Daily report scheduled: ${cronExpr}`);
}

export function startSymbolUpdateScheduler(onSymbolsUpdated: (symbols: string[]) => void) {
  const cronExpr = config.symbolUpdateCron;

  if (!cron.validate(cronExpr)) {
    logger.error(`Invalid symbol update cron expression: ${cronExpr}`);
    return;
  }

  cron.schedule(cronExpr, async () => {
    logger.info('SymbolSelector: running daily volume snapshot...');
    try {
      await snapshotDailyVolumes();
      const symbols = await getTopSymbols();
      onSymbolsUpdated(symbols);
    } catch (err) {
      logger.error('SymbolSelector: daily update failed', err);
    }
  });

  logger.info(`Symbol update scheduled: ${cronExpr}`);
}