import { config } from '../config/settings.js';
import { roundQuantity, isValidNumber } from '../utils/helpers.js';
import logger from '../utils/logger.js';

/**
 * Розраховує параметри позиції на основі POSITION_SIZE_PERCENT від балансу.
 *
 * Логіка:
 *   positionSizeUSDT = balance * (POSITION_SIZE_PERCENT / 100)
 *   quantity         = positionSizeUSDT / currentPrice   (округлено по tickSize)
 *   requiredMargin   = positionSizeUSDT / leverage
 *
 * TP/SL не розраховуються — позиція закривається виключно по EXIT-сигналу
 * від Spread Monitor Bot.
 *
 * @param {number} balance     — доступний баланс USDT
 * @param {number} entryPrice  — поточна ціна входу
 * @param {string} direction   — 'LONG' або 'SHORT'
 * @param {Object} symbolInfo  — { tickSize, minQty, maxQty } з bybitService.getSymbolInfo()
 * @returns {Object} параметри позиції
 */
export function calculatePositionParameters(balance, entryPrice, direction, symbolInfo = {}) {
  try {
    // --- Валідація вхідних даних ---
    if (!isValidNumber(balance) || balance <= 0) {
      throw new Error(`Invalid balance: ${balance}`);
    }

    if (!isValidNumber(entryPrice) || entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }

    if (direction !== 'LONG' && direction !== 'SHORT') {
      throw new Error(`Invalid direction: ${direction}. Must be LONG or SHORT`);
    }

    const leverage            = config.risk.leverage;
    const positionSizePercent = config.risk.positionSizePercent;

    // 1. Розмір позиції в USDT
    const positionSizeUSDT = balance * (positionSizePercent / 100);
    logger.info(
      `[RISK] Balance: ${balance} USDT | ` +
      `Position size: ${positionSizePercent}% = ${positionSizeUSDT.toFixed(4)} USDT`
    );

    // 2. Необхідна маржа
    const requiredMargin = positionSizeUSDT / leverage;
    logger.info(
      `[RISK] Leverage: ${leverage}x | Required margin: ${requiredMargin.toFixed(4)} USDT`
    );

    // 3. Кількість контрактів
    const tickSize = symbolInfo.tickSize || 0.0001;
    const minQty   = symbolInfo.minQty   || 0;
    const maxQty   = symbolInfo.maxQty   || Infinity;

    let quantity = positionSizeUSDT / entryPrice;
    quantity = roundQuantity(quantity, tickSize);

    // Перевірка мінімального розміру
    if (quantity < minQty) {
      logger.warn(
        `[RISK] Calculated quantity (${quantity}) < minimum (${minQty}). Using minimum.`
      );
      quantity = minQty;
    }

    // Перевірка максимального розміру
    if (quantity > maxQty) {
      logger.warn(
        `[RISK] Calculated quantity (${quantity}) > maximum (${maxQty}). Using maximum.`
      );
      quantity = maxQty;
    }

    // 4. Фінальна перевірка маржі
    const finalRequiredMargin = (quantity * entryPrice) / leverage;

    if (finalRequiredMargin > balance) {
      throw new Error(
        `Insufficient balance. Required margin: ${finalRequiredMargin.toFixed(4)} USDT, ` +
        `Available: ${balance} USDT`
      );
    }

    const result = {
      entryPrice:       entryPrice,
      quantity:         quantity,
      positionSizeUSDT: positionSizeUSDT,
      leverage:         leverage,
      requiredMargin:   finalRequiredMargin,
      direction:        direction
      // takeProfit та stopLoss навмисно відсутні —
      // позиція закривається виключно по CLOSE-сигналу
    };

    logger.info(
      `[RISK] Position params: ${quantity} ${direction} @ ${entryPrice} | ` +
      `Size: ${positionSizeUSDT.toFixed(2)} USDT | Margin: ${finalRequiredMargin.toFixed(4)} USDT`
    );

    return result;
  } catch (error) {
    logger.error(`[RISK] Error calculating position parameters: ${error.message}`);
    throw error;
  }
}

/**
 * Перевіряє чи достатньо балансу для відкриття позиції
 *
 * @param {number} balance        — доступний баланс USDT
 * @param {number} requiredMargin — необхідна маржа USDT
 * @returns {boolean}
 */
export function hasSufficientBalance(balance, requiredMargin) {
  return (
    isValidNumber(balance) &&
    isValidNumber(requiredMargin) &&
    balance >= requiredMargin
  );
}

export default {
  calculatePositionParameters,
  hasSufficientBalance
};
