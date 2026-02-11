import { RestClientV5 } from 'bybit-api';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

class BybitService {
  constructor() {
    this.client = new RestClientV5({
      key: config.bybit.apiKey,
      secret: config.bybit.apiSecret,
      testnet: config.bybit.testnet
    });

    this.isConnected = false;
  }

  /**
   * Повертає positionIdx в залежності від режиму позицій акаунта.
   * ONE_WAY: 0
   * HEDGE: LONG=1, SHORT=2
   */
  getPositionIdx(direction) {
    const mode = (config.bybit.positionMode || 'ONE_WAY').toUpperCase();
    if (mode === 'HEDGE') {
      return direction === 'LONG' ? 1 : 2;
    }
    return 0;
  }

  /**
   * Перевіряє з'єднання з API
   */
  async connect() {
    try {
      logger.info('[BYBIT] Connecting to Bybit API...');
      const response = await this.client.getServerTime();

      if (response.retCode === 0) {
        this.isConnected = true;
        logger.info(`[BYBIT] ✅ Connected to Bybit ${config.bybit.testnet ? 'TESTNET' : 'MAINNET'}`);
        return true;
      } else {
        throw new Error(`API Error: ${response.retMsg}`);
      }
    } catch (error) {
      logger.error(`[BYBIT] Connection failed: ${error.message}`);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Отримує баланс USDT на Futures акаунті
   */
  async getUSDTBalance() {
    try {
      const response = await this.client.getWalletBalance({
        accountType: 'UNIFIED'
      });

      if (response.retCode !== 0) {
        throw new Error(`Failed to get balance: ${response.retMsg}`);
      }

      const coins = response.result?.list?.[0]?.coin || [];
      const usdtCoin = coins.find(coin => coin.coin === 'USDT');

      if (!usdtCoin) {
        logger.warn('[BYBIT] USDT not found in wallet');
        return 0;
      }

      const availableBalance = parseFloat(
        usdtCoin.availableToWithdraw || usdtCoin.walletBalance || '0'
      );
      logger.info(`[BYBIT] USDT Balance: ${availableBalance} USDT`);

      return availableBalance;
    } catch (error) {
      logger.error(`[BYBIT] Error getting balance: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує інформацію про символ (tickSize, minQty, maxQty, pricePrecision)
   */
  async getSymbolInfo(symbol) {
    try {
      const response = await this.client.getInstrumentsInfo({
        category: 'linear',
        symbol: symbol
      });

      if (response.retCode !== 0) {
        throw new Error(`Failed to get symbol info: ${response.retMsg}`);
      }

      const instrument = response.result?.list?.[0];
      if (!instrument) {
        throw new Error(`Symbol ${symbol} not found`);
      }

      return {
        symbol:         instrument.symbol,
        tickSize:       parseFloat(instrument.lotSizeFilter?.qtyStep || '0.0001'),
        minQty:         parseFloat(instrument.lotSizeFilter?.minQty  || '0'),
        maxQty:         parseFloat(instrument.lotSizeFilter?.maxQty  || '999999999'),
        pricePrecision: parseInt(instrument.priceScale || '4'),
        status:         instrument.status,
        baseCoin:       instrument.baseCoin,
        quoteCoin:      instrument.quoteCoin
      };
    } catch (error) {
      logger.error(`[BYBIT] Error getting symbol info for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує поточну ціну символу
   */
  async getCurrentPrice(symbol) {
    try {
      const response = await this.client.getTickers({
        category: 'linear',
        symbol: symbol
      });

      if (response.retCode !== 0) {
        throw new Error(`Failed to get price: ${response.retMsg}`);
      }

      const ticker = response.result?.list?.[0];
      if (!ticker) {
        throw new Error(`Ticker for ${symbol} not found`);
      }

      const lastPrice = parseFloat(ticker.lastPrice);
      logger.info(`[BYBIT] Current price for ${symbol}: ${lastPrice}`);

      return lastPrice;
    } catch (error) {
      logger.error(`[BYBIT] Error getting current price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Встановлює плече для символу
   */
  async setLeverage(symbol, leverage) {
    try {
      logger.info(`[BYBIT] Setting leverage ${leverage}x for ${symbol}...`);

      const response = await this.client.setLeverage({
        category:     'linear',
        symbol:       symbol,
        buyLeverage:  leverage.toString(),
        sellLeverage: leverage.toString()
      });

      if (
        response.retCode === 0 ||
        response.retCode === 110043 ||
        response.retMsg?.includes('leverage not modified')
      ) {
        logger.info(`[BYBIT] ✅ Leverage ${leverage}x set for ${symbol}`);
        return true;
      }

      throw new Error(`Failed to set leverage: ${response.retMsg} (code: ${response.retCode})`);
    } catch (error) {
      if (
        error.message?.includes('leverage not modified') ||
        error.message?.includes('110043') ||
        error.code === 110043
      ) {
        logger.info(`[BYBIT] ✅ Leverage already ${leverage}x for ${symbol}`);
        return true;
      }

      logger.error(`[BYBIT] Error setting leverage: ${error.message}`);
      throw error;
    }
  }

  /**
   * Відкриває Market ордер
   */
  async openMarketOrder(symbol, side, quantity, positionIdx = 0) {
    try {
      logger.info(`[BYBIT] Opening ${side} market order: ${quantity} ${symbol}...`);

      const response = await this.client.submitOrder({
        category:    'linear',
        symbol:      symbol,
        side:        side,         // 'Buy' або 'Sell'
        orderType:   'Market',
        qty:         quantity.toString(),
        positionIdx: positionIdx   // 0: one-way, 1: hedge LONG, 2: hedge SHORT
      });

      if (response.retCode !== 0) {
        throw new Error(`Failed to open order: ${response.retMsg}`);
      }

      const orderId = response.result?.orderId;
      logger.info(`[BYBIT] ✅ Market order opened: Order ID ${orderId}`);

      return {
        orderId:     orderId,
        orderLinkId: response.result?.orderLinkId,
        symbol:      symbol,
        side:        side,
        quantity:    quantity
      };
    } catch (error) {
      logger.error(`[BYBIT] Error opening market order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Закриває позицію Market ордером з reduceOnly: true.
   *
   * @param {string} symbol       — торгова пара, наприклад 'BTCUSDT'
   * @param {string} closeSide    — 'Buy' (для закриття SHORT) або 'Sell' (для закриття LONG)
   * @param {number} quantity     — кількість контрактів для закриття
   * @param {number} positionIdx  — 0: one-way, 1: hedge LONG, 2: hedge SHORT
   */
  async closeMarketOrder(symbol, closeSide, quantity, positionIdx = 0) {
    try {
      logger.info(`[BYBIT] Closing position: ${closeSide} ${quantity} ${symbol} (reduceOnly)...`);

      const response = await this.client.submitOrder({
        category:    'linear',
        symbol:      symbol,
        side:        closeSide,
        orderType:   'Market',
        qty:         quantity.toString(),
        reduceOnly:  true,
        positionIdx: positionIdx
      });

      if (response.retCode !== 0) {
        throw new Error(`Failed to close position: ${response.retMsg} (code: ${response.retCode})`);
      }

      const orderId = response.result?.orderId;
      logger.info(`[BYBIT] ✅ Close order submitted: Order ID ${orderId}`);

      return {
        orderId:     orderId,
        orderLinkId: response.result?.orderLinkId,
        symbol:      symbol,
        side:        closeSide,
        quantity:    quantity
      };
    } catch (error) {
      logger.error(`[BYBIT] Error closing market order for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує відкриті позиції
   */
  async getOpenPositions(symbol = null) {
    try {
      const params = { category: 'linear' };

      if (symbol) {
        params.symbol = symbol;
      } else {
        params.settleCoin = 'USDT';
      }

      const response = await this.client.getPositionInfo(params);

      if (response.retCode !== 0) {
        throw new Error(`Failed to get positions: ${response.retMsg}`);
      }

      const positions = (response.result?.list || [])
        .filter(pos => parseFloat(pos.size || '0') !== 0)
        .map(pos => ({
          symbol:        pos.symbol,
          side:          pos.side,
          size:          parseFloat(pos.size   || '0'),
          entryPrice:    parseFloat(pos.avgPrice   || '0'),
          markPrice:     parseFloat(pos.markPrice  || '0'),
          unrealisedPnl: parseFloat(pos.unrealisedPnl || '0'),
          leverage:      parseFloat(pos.leverage || '1'),
          positionIdx:   parseInt(pos.positionIdx || '0')
        }));

      return positions;
    } catch (error) {
      logger.error(`[BYBIT] Error getting open positions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Перевіряє чи є відкрита позиція по символу
   */
  async hasOpenPosition(symbol) {
    const positions = await this.getOpenPositions(symbol);
    return positions.length > 0;
  }

  /**
   * Отримує історію угод
   */
  async getTradeHistory(symbol = null, limit = 50) {
    try {
      const params = { category: 'linear', limit };
      if (symbol) params.symbol = symbol;

      const response = await this.client.getExecutionList(params);

      if (response.retCode !== 0) {
        throw new Error(`Failed to get trade history: ${response.retMsg}`);
      }

      return response.result?.list || [];
    } catch (error) {
      logger.error(`[BYBIT] Error getting trade history: ${error.message}`);
      throw error;
    }
  }
}

// Експортуємо singleton
const bybitService = new BybitService();
export default bybitService;
