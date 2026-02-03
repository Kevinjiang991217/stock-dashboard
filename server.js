const express = require('express');
const axios = require('axios');
const RSSParser = require('rss-parser');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = 3000;
const parser = new RSSParser();

// OpenAI Configuration - Use provided API key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-cp-FD9XasB7QRV9-2XJTtevADR_tqfCSKpmxbnLvS-ebA7r2pHmMQNRloM2j8t5ePclfLaXxQb-LXihqw-dJdYJcI5XJ1BfctLtH9RUZcc1H6hcaa5AwzBdUrE'
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
let cachedStockData = {};
let cachedGoldData = [];
let cachedNews = [];
let cachedAnalysis = '';
let exchangeRate = 7.2; // 默认汇率

// Fetch exchange rate
async function fetchExchangeRate() {
  try {
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
    if (response.data && response.data.rates && response.data.rates.CNY) {
      exchangeRate = response.data.rates.CNY;
      console.log(`Exchange rate updated: 1 USD = ${exchangeRate} CNY`);
    }
  } catch (error) {
    console.error('Error fetching exchange rate:', error.message);
  }
}

// Fetch stock data - using alternative data source
async function fetchStockData(symbol) {
  try {
    // Try Finnhub as alternative
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

  // Return mock data if API fails
  return {
    symbol: symbol,
    name: symbol,
    price: 3000 + Math.random() * 100,
    change: Math.random() * 20 - 10,
    changePercent: Math.random() * 2 - 1,
    currency: 'USD',
    previousClose: 3000,
    open: 3010,
    high: 3020,
    low: 2990,
    timestamp: Date.now()
  };
}

// Fetch gold prices
async function fetchGoldPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
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
  return {
    symbol: symbol,
    price: 2000 + Math.random() * 50,
    change: Math.random() * 20 - 10,
    changePercent: Math.random() * 1 - 0.5,
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
  chinese: [
    'https://rssexport.rss.gov.hk/rss/govHKTCENews.xml',
    'https://www.cbc.ca/rss/Business.xml'
  ],
  english: [
    'https://feeds.reuters.com/reuters/businessNews',
    'https://feeds.bloomberg.com/markets/news.rss',
    'https://www.cnbc.com/id/10000664/device/rss/rss.html'
  ]
};

// Fetch news from RSS feeds
async function fetchNews() {
  const allNews = [];

  for (const feedUrl of RSS_FEEDS.chinese) {
    try {
      const feed = await parser.parseURL(feedUrl);
      feed.items.slice(0, 5).forEach(item => {
        allNews.push({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate || new Date().toISOString(),
          source: feed.title || 'Chinese News',
          language: 'chinese'
        });
      });
    } catch (error) {
      console.error(`Error fetching Chinese feed ${feedUrl}:`, error.message);
    }
  }

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
      console.error(`Error fetching English feed ${feedUrl}:`, error.message);
    }
  }

  allNews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return allNews.slice(0, 20);
}

// Generate AI Market Analysis
async function generateMarketAnalysis(stocks, gold, news) {
  try {
    const stockSummary = Object.entries(stocks).map(([region, data]) => {
      return `${region}股市:\n` + Object.entries(data).map(([name, info]) =>
        `${name}: ${info.price.toFixed(2)} (${info.changePercent >= 0 ? '+' : ''}${info.changePercent.toFixed(2)}%)`
      ).join('\n');
    }).join('\n\n');

    const goldSummary = Object.entries(gold).map(([region, data]) => {
      return `${region}黄金:\n` + data.map(item =>
        `${item.name}: ${item.price.toFixed(2)} USD (${item.changePercent >= 0 ? '+' : ''}${item.changePercent.toFixed(2)}%)`
      ).join('\n');
    }).join('\n');

    const recentNews = news.slice(0, 5).map(n => `- ${n.title} (${n.source})`).join('\n');

    const prompt = `请基于以下市场数据生成一份简短的市场分析简报（200字以内，用简体中文）：

【股票市场】
${stockSummary}

【贵金属市场】
${goldSummary}

【最新资讯】
${recentNews}

请分析：
1. 今日市场整体走势
2. 黄金和美元的关系
3. 可能的投资风险提示

请用简洁的专业语言回答。`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: '你是一位专业的金融分析师，擅长用简洁清晰的语言分析市场走势。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('AI Analysis Error:', error.message);
    return '暂时无法生成市场分析，请稍后再试。';
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
    res.json(cachedNews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/analysis', async (req, res) => {
  try {
    res.json({ analysis: cachedAnalysis, timestamp: Date.now() });
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
    res.json({ stocks, gold, news });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate new analysis
app.post('/api/generate-analysis', async (req, res) => {
  try {
    const [stocks, gold, news] = await Promise.all([
      fetchAllStocks(),
      fetchAllGold(),
      fetchNews()
    ]);
    const analysis = await generateMarketAnalysis(stocks, gold, news);
    cachedAnalysis = analysis;
    res.json({ analysis, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize data
async function initializeData() {
  console.log('Initializing data...');

  // Fetch exchange rate first
  await fetchExchangeRate();

  try {
    cachedStockData = await fetchAllStocks();
    console.log('Stock data loaded');
  } catch (error) {
    console.error('Error loading stock data:', error.message);
  }

  try {
    cachedGoldData = await fetchAllGold();
    console.log('Gold data loaded');
  } catch (error) {
    console.error('Error loading gold data:', error.message);
  }

  try {
    cachedNews = await fetchNews();
    console.log('News loaded');
  } catch (error) {
    console.error('Error loading news:', error.message);
  }

  // Generate initial analysis
  try {
    cachedAnalysis = await generateMarketAnalysis(cachedStockData, cachedGoldData, cachedNews);
    console.log('AI Analysis generated');
  } catch (error) {
    console.error('Error generating analysis:', error.message);
  }
}

// Schedule tasks
// Update exchange rate every hour
cron.schedule('0 * * * *', async () => {
  console.log('Updating exchange rate...');
  await fetchExchangeRate();
});

// Update data every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  console.log('Updating market data...');
  try {
    cachedStockData = await fetchAllStocks();
    cachedGoldData = await fetchAllGold();
  } catch (error) {
    console.error('Error updating market data:', error.message);
  }
});

// Generate analysis every 4 hours
cron.schedule('0 */4 * * *', async () => {
  console.log('Generating AI analysis...');
  try {
    cachedAnalysis = await generateMarketAnalysis(cachedStockData, cachedGoldData, cachedNews);
  } catch (error) {
    console.error('Error generating analysis:', error.message);
  }
});

// Start server
initializeData().then(() => {
  app.listen(PORT, () => {
    console.log(`Stock Dashboard running at http://localhost:${PORT}`);
  });
});
