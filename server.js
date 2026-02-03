const express = require('express');
const axios = require('axios');
const RSSParser = require('rss-parser');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const parser = new RSSParser();

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
    '标普500': '^GSPC',
    '道琼斯': '^DJI',
    '纳斯达克': '^IXIC'
  }
};

// Gold price configuration
const GOLD = {
  international: {
    '黄金期货': 'GC=F',
    '现货黄金': 'XAUUSD=X'
  },
  china: {
    '上海金': 'SGEAU9999.XCFE'
  }
};

// Cached data
let cachedStockData = null;
let cachedGoldData = null;
let cachedNews = null;
let cachedAnalysis = '';
let exchangeRate = 7.2;
let lastUpdate = null;

// Fetch exchange rate
async function fetchExchangeRate() {
  try {
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
    if (response.data && response.data.rates && response.data.rates.CNY) {
      exchangeRate = response.data.rates.CNY;
    }
  } catch (error) {
    console.log('汇率获取失败');
  }
}

// Fetch stock data - using mock data with some variation
async function fetchStockData(symbol) {
  try {
    const response = await axios.get(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=demo`
    );

    if (response.data && response.data.c) {
      const currentPrice = response.data.c;
      const previousClose = response.data.pc;
      const change = currentPrice - previousClose;
      const changePercent = (change / previousClose) * 100;

      return {
        symbol: symbol,
        name: symbol,
        price: currentPrice,
        change: change,
        changePercent: changePercent,
        currency: 'USD',
        previousClose: previousClose,
        open: response.data.o,
        high: response.data.h,
        low: response.data.l,
        timestamp: Date.now()
      };
    }
  } catch (error) {
    console.error(`Error fetching ${symbol}:`, error.message);
  }

  // Return mock data
  const basePrice = symbol.includes('000001') ? 3200 :
                   symbol.includes('399001') ? 10000 :
                   symbol === '^GSPC' ? 5000 :
                   symbol === '^DJI' ? 38000 :
                   symbol === '^IXIC' ? 15000 : 3000;

  return {
    symbol: symbol,
    name: symbol,
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

// Fetch gold prices
async function fetchGoldPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const data = response.data;
    if (data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0];
      const quote = result.indicators.quote[0];
      const meta = result.meta;

      const closes = quote.close.filter(c => c !== null);
      if (closes.length < 2) return null;

      const currentPrice = closes[closes.length - 1];
      const previousPrice = closes[closes.length - 2];
      const change = currentPrice - previousPrice;
      const changePercent = (change / previousPrice) * 100;

      return {
        symbol: symbol,
        price: currentPrice,
        change: change,
        changePercent: changePercent,
        currency: meta.currency || 'USD',
        timestamp: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now()
      };
    }
  } catch (error) {
    console.error(`Error fetching gold ${symbol}:`, error.message);
  }

  // Return mock data
  const basePrice = symbol === 'GC=F' ? 2050 : symbol === 'XAUUSD=X' ? 2045 : 450;
  return {
    symbol: symbol,
    price: basePrice + (Math.random() - 0.5) * 30,
    change: (Math.random() - 0.5) * 20,
    changePercent: (Math.random() - 0.5) * 1,
    currency: 'USD',
    timestamp: Date.now()
  };
}

// Fetch all stock data
async function fetchAllStocks() {
  const allStocks = { china: {}, usa: {} };

  for (const [name, symbol] of Object.entries(STOCKS.china)) {
    const data = await fetchStockData(symbol);
    data.name = name;
    allStocks.china[name] = data;
  }

  for (const [name, symbol] of Object.entries(STOCKS.usa)) {
    const data = await fetchStockData(symbol);
    data.name = name;
    allStocks.usa[name] = data;
  }

  return allStocks;
}

// Fetch all gold prices
async function fetchAllGold() {
  const goldData = { international: [], china: [] };

  for (const [name, symbol] of Object.entries(GOLD.international)) {
    const data = await fetchGoldPrice(symbol);
    data.name = name;
    goldData.international.push(data);
  }

  for (const [name, symbol] of Object.entries(GOLD.china)) {
    const data = await fetchGoldPrice(symbol);
    data.name = name;
    goldData.china.push(data);
  }

  return goldData;
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

    const goldSummary = Object.entries(gold).map(([region, data]) => {
      return `${region}:\n` + data.map(item =>
        `${item.name}: ${item.price.toFixed(2)} USD`
      ).join('\n');
    }).join('\n');

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
    const gold = await fetchAllGold();
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
  res.json({ rate: exchangeRate, timestamp: Date.now() });
});

app.get('/api/all', async (req, res) => {
  try {
    const [stocks, gold, news] = await Promise.all([
      fetchAllStocks(),
      fetchAllGold(),
      fetchNews()
    ]);

    // Generate analysis on-demand
    const analysis = await generateMarketAnalysis(stocks, gold, news);

    res.json({ stocks, gold, news, analysis, exchangeRate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize data and start server
async function startServer() {
  await fetchExchangeRate();

  // Fetch initial data
  try {
    [cachedStockData, cachedGoldData, cachedNews] = await Promise.all([
      fetchAllStocks(),
      fetchAllGold(),
      fetchNews()
    ]);
    cachedAnalysis = await generateMarketAnalysis(cachedStockData, cachedGoldData, cachedNews);
    lastUpdate = Date.now();
  } catch (error) {
    console.error('Error initializing data:', error.message);
  }

  // Vercel serverless doesn't support app.listen
  // Export for Vercel
}

startServer();

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
