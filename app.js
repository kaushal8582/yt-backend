require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 60 * 60 * 1000;

const cache = new Map();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

app.use('/api', limiter);

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

function extractChannelRef(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const handleMatch = trimmed.match(/youtube\.com\/@([a-zA-Z0-9._-]+)/);
  if (handleMatch) return { type: 'handle', value: handleMatch[1] };
  const channelMatch = trimmed.match(/youtube\.com\/channel\/([a-zA-Z0-9_-]+)/);
  if (channelMatch) return { type: 'id', value: channelMatch[1] };
  const cMatch = trimmed.match(/youtube\.com\/c\/([a-zA-Z0-9._-]+)/);
  if (cMatch) return { type: 'username', value: cMatch[1] };
  const userMatch = trimmed.match(/youtube\.com\/user\/([a-zA-Z0-9._-]+)/);
  if (userMatch) return { type: 'username', value: userMatch[1] };
  if (trimmed.startsWith('@')) return { type: 'handle', value: trimmed.slice(1) };
  return null;
}

function parseDuration(iso) {
  if (!iso) return { formatted: null, seconds: 0 };
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return { formatted: null, seconds: 0 };
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  const seconds = h * 3600 + m * 60 + s;
  if (h > 0) return { formatted: `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`, seconds };
  return { formatted: `${m}:${String(s).padStart(2, '0')}`, seconds };
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'me', 'him', 'us', 'them',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each',
  'video', 'official', 'new', 'full', 'hd', '4k', '2024', '2025', '2026',
]);

function deriveKeywords({ title, tags = [], description = '' }) {
  const freq = new Map();
  const addPhrase = text => {
    if (!text) return;
    text.toLowerCase().split(/[\s|,\-–—]+/).forEach(word => {
      const cleaned = word.replace(/[^\w]/g, '').trim();
      if (cleaned.length < 3 || STOP_WORDS.has(cleaned)) return;
      freq.set(cleaned, (freq.get(cleaned) || 0) + 1);
    });
  };
  tags.forEach(tag => addPhrase(tag));
  addPhrase(title);
  addPhrase(description.slice(0, 300));
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ keyword: word, score: count }));
}

function deriveHashtags({ title, tags = [] }) {
  const words = new Set();
  tags.forEach(tag => {
    tag.split(/\s+/).forEach(w => {
      const c = w.replace(/[^\w]/g, '').toLowerCase();
      if (c.length >= 3) words.add(c);
    });
  });
  title.split(/\s+/).forEach(w => {
    const c = w.replace(/[^\w]/g, '').toLowerCase();
    if (c.length >= 4 && !STOP_WORDS.has(c)) words.add(c);
  });
  return [...words].slice(0, 25).map(w => `#${w.replace(/\s/g, '')}`);
}

function suggestExtraTags({ title, tags = [] }) {
  const existing = new Set(tags.map(t => t.toLowerCase()));
  const suggestions = [];
  title.split(/\s+/).forEach(w => {
    const c = w.replace(/[^\w]/g, '').toLowerCase();
    if (c.length >= 4 && !STOP_WORDS.has(c) && !existing.has(c)) {
      suggestions.push(c);
      existing.add(c);
    }
  });
  tags.forEach(tag => {
    [`${tag} gameplay`, `${tag} tutorial`, `${tag} tips`].forEach(s => {
      if (!existing.has(s.toLowerCase()) && suggestions.length < 20) {
        suggestions.push(s);
        existing.add(s.toLowerCase());
      }
    });
  });
  return suggestions.slice(0, 15);
}

function computeTagSeoScore(tags = [], title = '') {
  if (!tags.length) return { score: 0, label: 'Weak', tips: ['No tags found. Add 10-15 relevant tags.'] };
  const tips = [];
  let score = 50;
  const count = tags.length;
  if (count >= 10 && count <= 15) score += 20;
  else if (count >= 5 && count <= 20) score += 10;
  else tips.push(count < 5 ? 'Too few tags. Aim for 10-15.' : 'Too many tags. Keep 10-15 best ones.');
  const avgLen = tags.reduce((s, t) => s + t.length, 0) / count;
  if (avgLen >= 8 && avgLen <= 25) score += 15;
  else tips.push('Tag length should be 8-25 characters on average.');
  const titleLower = title.toLowerCase();
  const inTitle = tags.filter(t => titleLower.includes(t.toLowerCase())).length;
  if (inTitle >= 2) score += 15;
  else tips.push('Include 2+ tags that appear in your title.');
  score = Math.min(100, Math.max(0, score));
  const label = score >= 75 ? 'Good' : score >= 50 ? 'Average' : 'Weak';
  return { score, label, tips };
}

async function youtubeFetch(path, params) {
  params.set('key', YOUTUBE_API_KEY);
  const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${params}`);
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `YouTube API error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function fetchVideoMetadata(videoId) {
  const cacheKey = `video:${videoId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: videoId,
  });
  const data = await youtubeFetch('videos', params);
  if (!data.items?.length) {
    const err = new Error('Video not found');
    err.status = 404;
    throw err;
  }

  const item = data.items[0];
  const snippet = item.snippet;
  const stats = item.statistics || {};
  const content = item.contentDetails || {};
  const thumbnails = snippet.thumbnails || {};
  const duration = parseDuration(content.duration);

  const result = {
    videoId,
    title: snippet.title,
    description: snippet.description,
    tags: snippet.tags || [],
    channelTitle: snippet.channelTitle,
    channelId: snippet.channelId,
    publishedAt: snippet.publishedAt,
    viewCount: stats.viewCount ?? null,
    likeCount: stats.likeCount ?? null,
    commentCount: stats.commentCount ?? null,
    duration: duration.formatted,
    durationSeconds: duration.seconds,
    definition: content.definition ?? null,
    thumbnail: {
      default: thumbnails.default?.url ?? null,
      medium: thumbnails.medium?.url ?? null,
      high: thumbnails.high?.url ?? null,
      standard: thumbnails.standard?.url ?? null,
      maxres: thumbnails.maxres?.url ?? null,
    },
    keywords: deriveKeywords({ title: snippet.title, tags: snippet.tags, description: snippet.description }),
    hashtags: deriveHashtags({ title: snippet.title, tags: snippet.tags }),
    suggestedTags: suggestExtraTags({ title: snippet.title, tags: snippet.tags || [] }),
    tagSeo: computeTagSeoScore(snippet.tags || [], snippet.title),
  };

  setCache(cacheKey, result);
  return result;
}

async function resolveChannelId(ref) {
  if (ref.type === 'id') return ref.value;
  const params = new URLSearchParams({ part: 'id' });
  if (ref.type === 'handle') params.set('forHandle', ref.value);
  else params.set('forUsername', ref.value);
  const data = await youtubeFetch('channels', params);
  if (!data.items?.length) {
    const err = new Error('Channel not found');
    err.status = 404;
    throw err;
  }
  return data.items[0].id;
}

async function fetchChannelData(url) {
  const ref = extractChannelRef(url);
  if (!ref) {
    const err = new Error('Invalid channel URL. Use @handle or /channel/ID');
    err.status = 400;
    throw err;
  }

  const cacheKey = `channel:${ref.type}:${ref.value}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const channelId = await resolveChannelId(ref);
  const chParams = new URLSearchParams({
    part: 'snippet,statistics',
    id: channelId,
  });
  const chData = await youtubeFetch('channels', chParams);
  const channel = chData.items[0];
  const snippet = channel.snippet;
  const stats = channel.statistics || {};

  const searchParams = new URLSearchParams({
    part: 'snippet',
    channelId,
    order: 'date',
    type: 'video',
    maxResults: '10',
  });
  const searchData = await youtubeFetch('search', searchParams);
  const recentVideos = (searchData.items || []).map(item => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title,
    publishedAt: item.snippet?.publishedAt,
    thumbnail: item.snippet?.thumbnails?.medium?.url ?? null,
  }));

  const result = {
    channelId,
    title: snippet.title,
    description: snippet.description?.slice(0, 300),
    customUrl: snippet.customUrl,
    publishedAt: snippet.publishedAt,
    thumbnail: snippet.thumbnails?.high?.url ?? null,
    subscriberCount: stats.subscriberCount ?? null,
    viewCount: stats.viewCount ?? null,
    videoCount: stats.videoCount ?? null,
    recentVideos,
  };

  setCache(cacheKey, result);
  return result;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheSize: cache.size, timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    message: 'YouTube metadata API',
    endpoints: {
      video: 'GET|POST /api/video?url=',
      keywords: 'GET /api/keywords?url=',
      channel: 'GET /api/channel?url=',
      compare: 'POST /api/compare body: { url1, url2 }',
      health: 'GET /health',
    },
  });
});

async function handleVideoRequest(req, res) {
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY is not set.' });
  }
  const url = req.body?.url ?? req.query?.url;
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
  }
  try {
    res.json(await fetchVideoMetadata(videoId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

app.get('/api/video', handleVideoRequest);
app.post('/api/video', handleVideoRequest);

app.get('/api/keywords', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY is not set.' });
  const videoId = extractVideoId(req.query.url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });
  try {
    const video = await fetchVideoMetadata(videoId);
    res.json({ videoId, title: video.title, keywords: video.keywords });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/channel', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY is not set.' });
  try {
    res.json(await fetchChannelData(req.query.url));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/compare', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YOUTUBE_API_KEY is not set.' });
  const { url1, url2 } = req.body || {};
  const id1 = extractVideoId(url1);
  const id2 = extractVideoId(url2);
  if (!id1 || !id2) return res.status(400).json({ error: 'Both valid YouTube URLs required' });
  try {
    const [v1, v2] = await Promise.all([fetchVideoMetadata(id1), fetchVideoMetadata(id2)]);
    const tags1 = new Set(v1.tags.map(t => t.toLowerCase()));
    const tags2 = new Set(v2.tags.map(t => t.toLowerCase()));
    const common = v1.tags.filter(t => tags2.has(t.toLowerCase()));
    const onlyVideo1 = v1.tags.filter(t => !tags2.has(t.toLowerCase()));
    const onlyVideo2 = v2.tags.filter(t => !tags1.has(t.toLowerCase()));
    res.json({
      video1: { videoId: v1.videoId, title: v1.title, tags: v1.tags },
      video2: { videoId: v2.videoId, title: v2.title, tags: v2.tags },
      common,
      onlyVideo1,
      onlyVideo2,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  const HEALTH_PING_MS = 3 * 60 * 1000;
  const healthUrl = `http://localhost:${PORT}/health`;

  setInterval(async () => {
    try {
      const res = await fetch(healthUrl);
      const data = await res.json();
      console.log(`[keep-alive] ${new Date().toISOString()} → ${data.status}`);
    } catch (err) {
      console.error('[keep-alive] ping failed:', err.message);
    }
  }, HEALTH_PING_MS);
});
