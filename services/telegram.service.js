import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

class TelegramService {
  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.channelId = config.telegram.channelId;
    this.signalCallbacks = [];

    this.setupMessageHandler();
  }

  /**
   * Налаштовує обробник повідомлень
   */
  setupMessageHandler() {
    // Слухаємо повідомлення З КАНАЛУ
    this.bot.on('channel_post', (msg) => {
      if (msg.chat.id.toString() === this.channelId.toString()) {
        this.handleChannelMessage(msg);
      }
    });

    this.bot.on('polling_error', (error) => {
      logger.error(`[TELEGRAM] Polling error: ${error.message}`);
    });

    logger.info('[TELEGRAM] ✅ Bot initialized and listening for channel posts');
  }

  /**
   * Обробляє повідомлення з каналу
   */
  async handleChannelMessage(msg) {
    try {
      const text = msg.text || msg.caption || '';

      if (this.isSignalMessage(text)) {
        const signal = this.parseSignal(text);

        if (signal) {
          logger.info(`[TELEGRAM] Signal received: type=${signal.type} symbol=${signal.symbol} direction=${signal.direction}`);

          for (const callback of this.signalCallbacks) {
            try {
              await callback(signal);
            } catch (error) {
              logger.error(`[TELEGRAM] Error in signal callback: ${error.message}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error(`[TELEGRAM] Error handling message: ${error.message}`);
    }
  }

  /**
   * Перевіряє чи це сигнальне повідомлення від Spread Monitor Bot.
   * Розпізнає два типи:
   *   - "📊 SPREAD SIGNAL"  — відкриття позиції
   *   - "✅ SPREAD CLOSED"  — закриття позиції
   */
  isSignalMessage(text) {
    if (!text) return false;
    return text.includes('SPREAD SIGNAL') || text.includes('SPREAD CLOSED');
  }

  /**
   * Парсить сигнал з повідомлення Spread Monitor Bot.
   *
   * Тип 1 — відкриття (починається з "📊 SPREAD SIGNAL"):
   *   Повертає: { type: 'OPEN', symbol, direction, lastPrice, indexPrice, spread, timestamp }
   *
   * Тип 2 — закриття (починається з "✅ SPREAD CLOSED"):
   *   Повертає: { type: 'CLOSE', symbol, direction, timestamp }
   */
  parseSignal(text) {
    try {
      if (text.includes('SPREAD SIGNAL')) {
        return this._parseOpenSignal(text);
      }

      if (text.includes('SPREAD CLOSED')) {
        return this._parseCloseSignal(text);
      }

      return null;
    } catch (error) {
      logger.error(`[TELEGRAM] Error parsing signal: ${error.message}`);
      return null;
    }
  }

  /**
   * Парсить OPEN сигнал.
   * Очікуваний формат:
   *   📊 SPREAD SIGNAL
   *   SYMBOL: BTCUSDT
   *   DIRECTION: LONG
   *   LAST_PRICE: 65000.00
   *   INDEX_PRICE: 64900.00
   *   SPREAD: 0.75%
   *   TIME: 2024-01-01T12:00:00.000Z
   */
  _parseOpenSignal(text) {
    const symbolMatch    = text.match(/SYMBOL:\s*(\S+)/i);
    const directionMatch = text.match(/DIRECTION:\s*(LONG|SHORT)/i);
    const lastPriceMatch = text.match(/LAST_PRICE:\s*([\d.]+)/i);
    const indexPriceMatch = text.match(/INDEX_PRICE:\s*([\d.]+)/i);
    const spreadMatch    = text.match(/SPREAD:\s*([-\d.]+)/i);
    const timeMatch      = text.match(/TIME:\s*(\S+)/i);

    if (!symbolMatch || !directionMatch) {
      logger.warn('[TELEGRAM] OPEN signal: missing required fields (SYMBOL or DIRECTION)');
      return null;
    }

    const signal = {
      type:       'OPEN',
      symbol:     symbolMatch[1].toUpperCase(),
      direction:  directionMatch[1].toUpperCase(),
      lastPrice:  lastPriceMatch  ? parseFloat(lastPriceMatch[1])  : null,
      indexPrice: indexPriceMatch ? parseFloat(indexPriceMatch[1]) : null,
      spread:     spreadMatch     ? parseFloat(spreadMatch[1])     : null,
      timestamp:  timeMatch ? new Date(timeMatch[1]).getTime() : Date.now()
    };

    logger.info(`[TELEGRAM] Parsed OPEN signal: ${signal.symbol} ${signal.direction} spread=${signal.spread}%`);
    return signal;
  }

  /**
   * Парсить CLOSE сигнал.
   * Очікуваний формат:
   *   ✅ SPREAD CLOSED
   *   SYMBOL: BTCUSDT
   *   DIRECTION: LONG
   *   LAST_PRICE: 65000.00
   *   INDEX_PRICE: 65010.00
   *   SPREAD: 0.45%
   *   TIME: 2024-01-01T12:30:00.000Z
   */
  _parseCloseSignal(text) {
    const symbolMatch    = text.match(/SYMBOL:\s*(\S+)/i);
    const directionMatch = text.match(/DIRECTION:\s*(LONG|SHORT)/i);
    const timeMatch      = text.match(/TIME:\s*(\S+)/i);

    if (!symbolMatch || !directionMatch) {
      logger.warn('[TELEGRAM] CLOSE signal: missing required fields (SYMBOL or DIRECTION)');
      return null;
    }

    const signal = {
      type:      'CLOSE',
      symbol:    symbolMatch[1].toUpperCase(),
      direction: directionMatch[1].toUpperCase(),
      timestamp: timeMatch ? new Date(timeMatch[1]).getTime() : Date.now()
    };

    logger.info(`[TELEGRAM] Parsed CLOSE signal: ${signal.symbol} ${signal.direction}`);
    return signal;
  }

  /**
   * Реєструє callback для обробки сигналів
   */
  onSignal(callback) {
    this.signalCallbacks.push(callback);
    logger.info('[TELEGRAM] Signal callback registered');
  }

  /**
   * Відправляє повідомлення в канал або чат
   */
  async sendMessage(chatId, message, options = {}) {
    try {
      const targetChatId = chatId || this.channelId;
      await this.bot.sendMessage(targetChatId, message, {
        parse_mode: 'HTML',
        ...options
      });
      logger.info(`[TELEGRAM] Message sent to ${targetChatId}`);
    } catch (error) {
      logger.error(`[TELEGRAM] Error sending message: ${error.message}`);
      throw error;
    }
  }

  /**
   * Форматує повідомлення про відкриття позиції
   */
  formatPositionOpenedMessage(positionData) {
    const {
      symbol,
      direction,
      entryPrice,
      quantity,
      leverage,
      positionSizeUSDT,
      balance,
      timestamp
    } = positionData;

    const cleanSymbol = symbol ? symbol.replace('USDT', '') : 'UNKNOWN';
    const directionEmoji = direction === 'LONG' ? '📈' : '📉';

    return `✅ <b>POSITION OPENED</b>

<b>Symbol:</b> ${symbol}
<b>Direction:</b> ${directionEmoji} ${direction}
<b>Entry Price:</b> $${entryPrice}
<b>Quantity:</b> ${quantity.toLocaleString()} ${cleanSymbol}
<b>Leverage:</b> ${leverage}x
💰 <b>Position Size:</b> $${positionSizeUSDT ? positionSizeUSDT.toFixed(2) : '—'}

Signal at: ${new Date(timestamp).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;
  }

  /**
   * Форматує повідомлення про закриття позиції
   */
  formatPositionClosedMessage(positionData) {
    const { symbol, direction, entryPrice, exitPrice, pnl, pnlPercent, duration } = positionData;

    const isProfit = pnl >= 0;
    const emoji = isProfit ? '🟢' : '🔴';
    const resultText = isProfit ? 'PROFIT' : 'LOSS';

    return `${emoji} <b>POSITION CLOSED - ${resultText}</b>

<b>Symbol:</b> ${symbol}
<b>Direction:</b> ${direction}
<b>Entry:</b> $${entryPrice}
<b>Exit:</b> $${exitPrice}
<b>Result:</b> ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})

<b>Duration:</b> ${duration}`;
  }

  /**
   * Форматує повідомлення про ігнорування сигналу
   */
  formatSignalIgnoredMessage(symbol, direction, reason, additionalInfo = {}) {
    let message = `⏰ <b>SIGNAL IGNORED</b>

<b>Symbol:</b> ${symbol}
<b>Direction:</b> ${direction}
<b>Reason:</b> ${reason}`;

    if (additionalInfo.currentTime) {
      message += `\n\n<b>Current time:</b> ${additionalInfo.currentTime} UTC`;
    }
    if (additionalInfo.tradingHours) {
      message += `\n<b>Trading hours:</b> ${additionalInfo.tradingHours}`;
    }
    if (additionalInfo.nextTrading) {
      message += `\n<b>Next trading:</b> in ${additionalInfo.nextTrading}`;
    }

    return message;
  }

  /**
   * Форматує щоденний звіт
   */
  formatDailyReport(report) {
    const winRate = report.totalTrades > 0
      ? ((report.winTrades / report.totalTrades) * 100).toFixed(1)
      : '0.0';

    const pnlEmoji = report.totalPnl >= 0 ? '💰' : '📉';
    const roiEmoji = report.roi >= 0 ? '📈' : '📉';

    return `📊 <b>DAILY REPORT</b>

<b>Date:</b> ${report.date}
<b>Trading Hours:</b> ${report.tradingHours.startHour}:00-${report.tradingHours.endHour}:00 UTC
<b>Total Signals:</b> ${report.totalSignals}
<b>Signals Ignored (off-hours):</b> ${report.signalsIgnored}
<b>Total Trades:</b> ${report.totalTrades}
✅ <b>Wins:</b> ${report.winTrades} (${winRate}%)
❌ <b>Losses:</b> ${report.loseTrades} (${(100 - parseFloat(winRate)).toFixed(1)}%)
${pnlEmoji} <b>Total P&L:</b> ${report.totalPnl >= 0 ? '+' : ''}$${report.totalPnl.toFixed(2)}
${roiEmoji} <b>ROI:</b> ${report.roi >= 0 ? '+' : ''}${report.roi.toFixed(2)}%

<b>Balance:</b> $${report.startBalance.toFixed(2)} → $${report.currentBalance.toFixed(2)}`;
  }
}

// Експортуємо singleton
const telegramService = new TelegramService();
export default telegramService;
