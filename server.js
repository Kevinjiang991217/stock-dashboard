const express = require('express');
const axios = require('axios');
const RSSParser = require('rss-parser');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const parser = new RSSParser();

// Configuration
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo';
const FRANKFURTER_BASE = 'https://api.frankfurter.app';

// OpenAI Configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-cp-FD9XasB7QRV9-2XJTtevADR_tqfCSKpmxbnLvS-ebA7r2pHmMQNRloM2j8t5ePclfLaXxQb-LXihqw-dJdYJcI5XJ1BfctLtH9RUZcc1H6hcaa5AwzBdUrE'
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Stock symbols configuration
const STOCKS = {
  china: {
    '上证指数': '000001.SS',
    '深证成指': '399001.SZ'
  },
  usa: {
    '标普500': 'SPX',
    '道琼斯': 'DJI',
    '纳斯达克': 'IXIC'
  }
};

// Gold price configuration - Alpha Vantage uses precious metals API
const GOLD = {
  international: {
    '黄金期货': 'GOLD',
    '现货黄金': 'XAU'
  }
};

// Cached data
let cachedStockData = null;
let cachedGoldData = null;
let cachedNews = null;
let cachedAnalysis = '';
let exchangeRate = 7.2;
let lastUpdate = null;

// Fetch exchange rate from Frankfurter (free, no auth)
async function fetchExchangeRate() {
  try {
    const response = await axios.get(`${FRANKFURTER_BASE}/latest?from=USD&to=CNY`);
    if (response.data && response.data.rates && response.data.rates.CNY) {
      exchangeRate = response.data.rates.CNY;
      console.log(`Frankfurter汇率: 1 USD = ${exchangeRate} CNY`);
    }
  } catch (error) {
    console.error('Frankfurter汇率获取失败:', error.message);
  }
}

// Alpha Vantage API helpers
const alphaVantage = {
  async quote(symbol) {
    try {
      // Try Alpha Vantage first
      const response = await axios.get(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`
      );
      const data = response.data;
      if (data['Global Quote'] && data['Global Quote']['05. price']) {
        const quote = data['Global Quote'];
        return {
          price: parseFloat(quote['05. price']),
          change: parseFloat(quote['09. change']),
          changePercent: parseFloat(quote['10. change percent'].replace('%', '')),
          open: parseFloat(quote['02. open']),
          high: parseFloat(quote['03. high']),
          low: parseFloat(quote['04. low']),
          previousClose: parseFloat(quote['08. previous close'])
        };
      }
    } catch (error) {
      console.error(`Alpha Vantage error for ${symbol}:`, error.message);
    }
    return null;
  },

  async timeSeriesDaily(symbol) {
    try {
      const response = await axios.get(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`
      );
      const data = response.data;
      if (data['Time Series (Daily)']) {
        const timeSeries = data['Time Series (Daily)'];
        return Object.entries(timeSeries).slice(0, 90).map(([date, values]) => ({
          time: new Date(date).getTime() / 1000,
          open: parseFloat(values['1. open']),
          high: parseFloat(values['2. high']),
          low: parseFloat(values['3. low']),
          close: parseFloat(values['4. close'])
        }));
      }
    } catch (error) {
      console.error(`Alpha Vantage history error for ${symbol}:`, error.message);
    }
    return null;
  },

  async preciousMetals() {
    try {
      const response = await axios.get(
        `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=XAU&apikey=${ALPHA_VANTAGE_KEY}`
      );
      const data = response.data;
      if (data['Realtime Currency Exchange Rate']) {
        const rate = data['Realtime Currency Exchange Rate'];
        return parseFloat(rate['5. Exchange Rate']);
      }
    } catch (error) {
      console.error('Alpha Vantage gold error:', error.message);
    }
    return null;
  }
};

// Fetch stock data
async function fetchStockData(symbol, name) {
  // Try Alpha Vantage
  const quote = await alphaVantage.quote(symbol);

  if (quote) {
    return {
      symbol: symbol,
      name: name,
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      currency: 'USD',
      previousClose: quote.previousClose,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      timestamp: Date.now()
    };
  }

  // Return mock data
  const basePrice = symbol === 'SPX' ? 5000 :
                   symbol === 'DJI' ? 38000 :
                   symbol === 'IXIC' ? 15000 :
                   symbol === '000001.SS' ? 3200 :
                   symbol === '399001.SZ' ? 10000 : 3000;

  return {
    symbol: symbol,
    name: name,
    price: basePrice + (Math.random() - 0.5) * 100,
    change: (Math.random() - 0.5) * 50,
    changePercent: (Math.random() - 0.5) * 2,
    currency: 'USD',
    previousClose: basePrice,
    open: basePrice + (Math.random() - 0.5) * 20,
    high: basePrice + Math.random() * 30,
    low: basePrice - Math.random() * 30,
    timestamp: Date.now()
  };
}

// Fetch gold price
async function fetchGoldData() {
  // Try Alpha Vantage for XAU/USD rate
  const xauRate = await alphaVantage.preciousMetals();

  if (xauRate) {
    // Convert per ounce to per kg (1 kg = 32.1507 oz)
    const pricePerOz = xauRate;
    const pricePerKg = pricePerOz * 32.1507;

    return {
      international: [{
        name: '现货黄金',
        price: pricePerKg,
        change: (Math.random() - 0.5) * 20,
        changePercent: (Math.random() - 0.5) * 1,
        currency: 'USD',
        timestamp: Date.now()
      }],
      china: []
    };
  }

  // Mock data (per kg)
  const basePricePerKg = 2050 * 31.1035; // ~63,700 CNY per kg

  return {
    international: [{
      name: '现货黄金',
      price: 64000 + (Math.random() - 0.5) * 1000,
      change: (Math.random() - 0.5) * 500,
      changePercent: (Math.random() - 0.5) * 1,
      currency: 'USD',
      timestamp: Date.now()
    }],
    china: [{
      name: '上海金',
      price: 450000 + (Math.random() - 0.5) * 5000,
      change: (Math.random() - 0.5) * 1000,
      changePercent: (Math.random() - 0.5) * 0.5,
      currency: 'CNY',
      timestamp: Date.now()
    }]
  };
}

// Fetch all stock data
async function fetchAllStocks() {
  const allStocks = { china: {}, usa: {} };

  for (const [name, symbol] of Object.entries(STOCKS.china)) {
    const data = await fetchStockData(symbol, name);
    allStocks.china[name] = data;
  }

  for (const [name, symbol] of Object.entries(STOCKS.usa)) {
    const data = await fetchStockData(symbol, name);
    allStocks.usa[name] = data;
  }

  return allStocks;
}

// RSS Feed URLs
const RSS_FEEDS = {
  english: [
    'https://feeds.reuters.com/reuters/businessNews',
    'https://feeds.bloomberg.com/markets/news.rss'
  ]
};

// Fetch news from RSS feeds
async function fetchNews() {
  const allNews = [];

  for (const feedUrl of RSS_FEEDS.english) {
    try {
      const feed = await parser.parseURL(feedUrl);
      feed.items.slice(0, 5).forEach(item => {
        allNews.push({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || new Date().toISOString(),
          source: feed.title || 'English News',
          language: 'english'
        });
      });
    } catch (error) {
      console.error(`Error fetching feed ${feedUrl}:`, error.message);
    }
  }

  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return allNews.slice(0, 10);
}

// Generate AI Market Analysis
async function generateMarketAnalysis(stocks, gold, news) {
  try {
    const stockSummary = Object.entries(stocks).map(([region, data]) => {
      return `${region}:\n` + Object.entries(data).map(([name, info]) =>
        `${name}: ${info.price.toFixed(2)} (${info.changePercent >= 0 ? '+' : ''}${info.changePercent.toFixed(2)}%)`
      ).join('\n');
    }).join('\n\n');

    const goldSummary = gold.international.map(item =>
      `${item.name}: ${(item.price / 31.1035).toFixed(2)} USD/盎司 (${item.price.toFixed(0)} CNY/公斤)`
    ).join('\n');

    const recentNews = news.slice(0, 3).map(n => `- ${n.title}`).join('\n');

    const prompt = `请用简体中文分析以下市场数据（150字以内）：

【股票】
${stockSummary}

【黄金】
${goldSummary}

【新闻】
${recentNews}

请简要分析：1. 市场整体走势 2. 黄金与美股关系 3. 投资建议`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: '你是专业金融分析师' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 300,
      temperature: 0.7
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('AI Analysis Error:', error.message);
    return 'AI分析暂时不可用，请稍后再试。';
  }
}

// API Routes
app.get('/api/stocks', async (req, res) => {
  try {
    const stocks = await fetchAllStocks();
    res.json(stocks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gold', async (req, res) => {
  try {
    const gold = await fetchGoldData();
    res.json(gold);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    if (!cachedNews) {
      cachedNews = await fetchNews();
    }
    res.json(cachedNews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/analysis', async (req, res) => {
  try {
    res.json({ analysis: cachedAnalysis, timestamp: lastUpdate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/exchange-rate', (req, res) => {
  res.json({ rate: exchangeRate, source: 'Frankfurter', timestamp: Date.now() });
});

// History data for K-line chart
app.get('/api/history/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const symbolMap = {
    'sp500': 'SPX',
    'nasdaq': 'IXIC',
    'gold': 'XAUUSD',
    'shanghai': '000001.SS'
  };

  const avSymbol = symbolMap[symbol] || symbol;

  // Try Alpha Vantage
  const candles = await alphaVantage.timeSeriesDaily(avSymbol);

  if (candles && candles.length > 0) {
    res.json({ source: 'Alpha Vantage', candles });
  } else {
    // Return mock data
    res.json({
      source: 'Mock',
      candles: generateMockCandles(symbol)
    });
  }
});

// Generate mock candles
function generateMockCandles(type) {
  const candles = [];
  const now = Math.floor(Date.now() / 1000);

  const basePrice = type === 'gold' ? 2000 :
                    type === 'sp500' ? 5000 :
                    type === 'nasdaq' ? 15000 :
                    type === 'shanghai' ? 3200 : 3000;

  for (let i = 90; i >= 0; i--) {
    const open = basePrice + (Math.random() - 0.5) * 200 + (90 - i) * 5;
    const change = (Math.random() - 0.5) * 50;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * 30;
    const low = Math.min(open, close) - Math.random() * 30;

    candles.push({
      time: now - i * 86400,
      open,
      high,
      low,
      close
    });
  }

  return candles;
}

app.get('/api/all', async (req, res) => {
  try {
    const [stocks, gold, news] = await Promise.all([
      fetchAllStocks(),
      fetchGoldData(),
      fetchNews()
    ]);

    const analysis = await generateMarketAnalysis(stocks, gold, news);

    res.json({ stocks, gold, news, analysis, exchangeRate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize data and start server
async function startServer() {
  await fetchExchangeRate();

  try {
    [cachedStockData, cachedGoldData, cachedNews] = await Promise.all([
      fetchAllStocks(),
      fetchGoldData(),
      fetchNews()
    ]);
    cachedAnalysis = await generateMarketAnalysis(cachedStockData, cachedGoldData, cachedNews);
    lastUpdate = Date.now();
  } catch (error) {
    console.error('Error initializing data:', error.message);
  }
}

startServer();

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Exchange rate source: Frankfurter`);
    console.log(`Stock data source: Alpha Vantage (demo key)`);
  });
}

module.exports = app;
